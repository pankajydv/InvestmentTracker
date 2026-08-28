import React, { useEffect, useState } from 'react';
import { Card, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS, ASSET_TYPE_FULL_NAMES, isPrivacyMaskEnabled, getMaskedValue } from '../utils/formatters';
import { usePrivacyMaskRefresh } from '../utils/privacyMode';

const INTEREST_RATE_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);
const MOBILE_BREAKPOINT_PX = 768;

export default function AssetTypeHoldingsTable({ type, info, portfolioTotalValue, selectedInterval, isIntervalSwitching }) {
  usePrivacyMaskRefresh();
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth < MOBILE_BREAKPOINT_PX : false),
  );

  useEffect(() => {
    const updateIsMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    };

    updateIsMobile();
    window.addEventListener('resize', updateIsMobile);
    return () => window.removeEventListener('resize', updateIsMobile);
  }, []);

  if (!info) return null;

  const getCurrencySymbol = (currency) => {
    const code = String(currency || 'INR').toUpperCase();
    if (code === 'INR') return '₹';
    if (code === 'USD') return '$';
    if (code === 'EUR') return '€';
    if (code === 'GBP') return '£';
    if (code === 'JPY') return '¥';
    return code;
  };

  const formatWithSymbol = (amount, currency, decimals = 2) => {
    const symbol = getCurrencySymbol(currency);
    const value = Number(amount) || 0;
    return `${value < 0 ? '-' : ''}${symbol}${formatNumber(Math.abs(value), decimals)}`;
  };

  const formatSensitiveAmount = (amount, decimals = 0, { currencySymbol = '' } = {}) => {
    if (isPrivacyMaskEnabled()) return getMaskedValue({ currencySymbol });
    return formatNumber(amount, decimals);
  };

  const formatAsOfDate = (dateValue) => {
    const formatted = formatDate(dateValue);
    if (!formatted) return formatted;
    return formatted.replace(/-\d{4}$/, '');
  };

  const isDayChangeMode = selectedInterval === '1D' || selectedInterval === 'YD';
  const selectedIntervalLabel = selectedInterval === 'CUSTOM' ? 'Cust' : selectedInterval;
  const baseSortColumns = [
    { key: 'name', label: 'Name', subLabel: 'Folios / Identifier' },
    { key: 'price', label: 'Last Price', subLabel: 'Avg Cost / Unit', end: true },
    {
      key: 'dayChange',
      label: `${selectedInterval === 'CUSTOM' ? 'Custom' : selectedInterval} Change`,
      subLabel: '% Change',
      end: true,
    },
    { key: 'totalCost', label: 'Net Invested', subLabel: 'Total Cost', end: true },
    { key: 'currentValue', label: 'Current Value', subLabel: 'Units Held', end: true },
    { key: 'portfolioPct', label: '% Portfolio', subLabel: '% within Type', end: true },
    { key: 'totalReturn', label: 'Total P&L', subLabel: 'Absolute | XIRR P&L%', end: true },
  ];
  const mobileSortColumns = [
    { key: 'name', label: 'Name', subLabel: 'Folios / Identifier' },
    { key: 'price', label: 'Last Price', subLabel: 'Avg / Value', end: true },
    {
      key: 'dayChange',
      label: '1D',
      subLabel: '% / Invested',
      end: true,
    },
    { key: 'totalReturn', label: 'Total P&L', subLabel: 'Abs | XIRR', end: true },
  ];

  const sortColumns = !INTEREST_RATE_ASSET_TYPES.has(type)
    ? baseSortColumns
    : baseSortColumns.map((col) => {
      if (col.key !== 'price') return col;
      return {
        ...col,
        label: 'Interest Rate',
        subLabel: 'As Of Date',
      };
    });

  const totalUnits = info.investments.reduce((sum, inv) => sum + (Number(inv.total_units) || 0), 0);
  const activeInvestments = info.investments.filter((inv) => (Number(inv.total_units) || 0) > 0.0001);
  const totalActiveUnits = activeInvestments.reduce((sum, inv) => sum + (Number(inv.total_units) || 0), 0);
  const weightedLivePrice = totalActiveUnits > 0
    ? activeInvestments.reduce((sum, inv) => sum + ((Number(inv.price_per_unit) || 0) * (Number(inv.total_units) || 0)), 0) / totalActiveUnits
    : null;
  const weightedAvgCostWeight = activeInvestments.reduce((sum, inv) => {
    const avgCost = Number(inv.avg_cost_per_unit_native);
    const units = Number(inv.total_units) || 0;
    return Number.isFinite(avgCost) && units > 0 ? sum + units : sum;
  }, 0);
  const weightedAvgCostPerUnit = weightedAvgCostWeight > 0
    ? activeInvestments.reduce((sum, inv) => {
      const avgCost = Number(inv.avg_cost_per_unit_native);
      const units = Number(inv.total_units) || 0;
      if (!Number.isFinite(avgCost) || units <= 0) return sum;
      return sum + (avgCost * units);
    }, 0) / weightedAvgCostWeight
    : null;
  const weightedPriceCurrency = activeInvestments[0]?.currency || 'INR';
  const latestTypeDate = info.investments.reduce((maxDate, inv) => {
    if (!inv.date) return maxDate;
    return !maxDate || inv.date > maxDate ? inv.date : maxDate;
  }, null);
  const totalDayChangePct = Number(info.intervalChangePct ?? 0);
  const totalAbsPct = Number(info.totalInvested || 0) > 0
    ? (Number(info.totalProfitLoss || 0) / Number(info.totalInvested || 0)) * 100
    : 0;
  const totalCurrentInvested = (Number(info.totalInvested) || 0) - (Number(info.totalRealizedGain) || 0);
  const showAsOfDateColumn = info.investments.some((inv) => !!inv.day_change_uses_fallback);
  const desktopColumns = showAsOfDateColumn
    ? [
        sortColumns[0],
        { key: 'asOfDate', label: 'As of Date' },
        ...sortColumns.slice(1),
      ]
    : sortColumns;
  const tableColumns = isMobile ? mobileSortColumns : desktopColumns;
  const tableColumnWidths = ['30%', '11.5%', '11.5%', '11.5%', '11.5%', '9%', '15%'];
  const tableColumnWidthsWithAsOfDate = ['26%', '10%', '10.5%', '10.5%', '10.5%', '10.5%', '9%', '13%'];
  const mobileTableColumnWidths = ['34%', '24%', '20%', '22%'];
  const columnWidths = isMobile
    ? mobileTableColumnWidths
    : (showAsOfDateColumn ? tableColumnWidthsWithAsOfDate : tableColumnWidths);

  const handleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return { key: null, direction: 'asc' };
    });
  };

  const sortInvestments = (investments) => {
    if (!sortConfig?.key) return investments;
    const fieldMap = {
      name: (inv) => inv.name,
      price: (inv) => inv.price_per_unit,
      dayChange: (inv) => inv.day_change,
      totalCost: (inv) => inv.invested_amount,
      currentValue: (inv) => inv.current_value,
      portfolioPct: (inv) => inv.portfolio_pct || 0,
      totalReturn: (inv) => inv.profit_loss,
    };
    const getValue = fieldMap[sortConfig.key];
    if (!getValue) return investments;
    return [...investments].sort((a, b) => {
      const aVal = getValue(a);
      const bVal = getValue(b);
      const cmp = sortConfig.key === 'name'
        ? String(aVal).localeCompare(String(bVal))
        : (aVal || 0) - (bVal || 0);
      return sortConfig.direction === 'desc' ? -cmp : cmp;
    });
  };

  if (isMobile) {
    return (
      <Card className="shadow-sm holdings-mobile-card">
        <Card.Header className="bg-white d-flex justify-content-between align-items-center">
          <h2 className="h6 fw-semibold mb-0" title={ASSET_TYPE_FULL_NAMES[type]}>
            {(ASSET_TYPE_FULL_NAMES[type] || ASSET_TYPE_LABELS[type])} ({info.investments.length})
          </h2>
          <Link to={`/investments?type=${type}`} className="small text-decoration-none d-flex align-items-center gap-1">
            View All <ArrowRight size={12} />
          </Link>
        </Card.Header>

        <div className="holdings-mobile-list">
          {sortInvestments(info.investments).map((inv) => {
            const investedAmount = Number(inv.invested_amount) || 0;
            const netInvested = investedAmount - (Number(inv.realized_proceeds) || 0);
            const fallbackAbsPct = investedAmount > 0
              ? ((Number(inv.profit_loss) || 0) / investedAmount) * 100
              : 0;
            const rowAbsPct = Number.isFinite(Number(inv.profit_loss_pct))
              ? Number(inv.profit_loss_pct)
              : fallbackAbsPct;
            const acquiredUnits = Number(inv.acquired_units) || 0;
            const avgCostText = acquiredUnits > 0.0001
              ? formatWithSymbol(inv.avg_cost_per_unit_native, inv.currency, 2)
              : '-';

            return (
              <div className="holdings-mobile-item" key={inv.id}>
                <div className="holdings-mobile-item-head">
                  <div className="holdings-mobile-name-wrap">
                    <Link
                      to={`/investments/${inv.id}`}
                      state={{ from: 'asset-type', fromLabel: ASSET_TYPE_LABELS[type] }}
                      className="holdings-mobile-name text-decoration-none"
                    >
                      {inv.name}
                    </Link>
                    {inv.asset_type === 'MUTUAL_FUND' && inv.open_folios_count !== undefined ? (
                      <span className="holdings-mobile-identifier">{inv.open_folios_count} folios</span>
                    ) : inv.amfi_code ? (
                      <span className="holdings-mobile-identifier">{inv.amfi_code}</span>
                    ) : null}
                  </div>
                  <div className="holdings-mobile-pnl">
                    <span className={`holdings-mobile-pnl-value ${profitColor(inv.profit_loss)}`}>
                      {formatSensitiveAmount(inv.profit_loss, 0)}
                    </span>
                    <span className={`holdings-mobile-pnl-rate ${profitColor(rowAbsPct)}`}>
                      {formatPct(rowAbsPct)} | {inv.xirr_pct == null ? 'N/A' : formatPct(inv.xirr_pct)}
                    </span>
                  </div>
                </div>

                <div className="holdings-mobile-metrics">
                  <div className="holdings-mobile-metric">
                    <span className="holdings-mobile-metric-label">Price</span>
                    <span className="holdings-mobile-metric-value text-nowrap">
                      {INTEREST_RATE_ASSET_TYPES.has(inv.asset_type)
                        ? (Number(inv.price_per_unit) > 0 ? `${formatNumber(inv.price_per_unit, 2)}%` : '-')
                        : formatWithSymbol(inv.price_per_unit, inv.currency, 2)}
                    </span>
                    <span className="holdings-mobile-metric-sub text-nowrap">Avg {avgCostText}</span>
                  </div>
                  <div className="holdings-mobile-metric">
                    <span className="holdings-mobile-metric-label">1D</span>
                    {isIntervalSwitching ? (
                      <>
                        <span className="holdings-mobile-metric-value text-muted">...</span>
                        <span className="holdings-mobile-metric-sub text-muted">...</span>
                      </>
                    ) : (
                      <>
                        <span className={`holdings-mobile-metric-value ${profitColor(inv.day_change)}`}>
                          {formatSensitiveAmount(inv.day_change, 0)}
                        </span>
                        <span className={`holdings-mobile-metric-sub ${profitColor(inv.day_change_pct)}`}>
                          {formatPct(inv.day_change_pct)}
                        </span>
                        {inv.day_change_uses_fallback && inv.day_change_as_of_date && (
                          <span className="holdings-mobile-asof">
                            As of {formatAsOfDate(inv.day_change_as_of_date)}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="holdings-mobile-metric">
                    <span className="holdings-mobile-metric-label">Current</span>
                    <span className="holdings-mobile-metric-value">{formatSensitiveAmount(inv.current_value, 0)}</span>
                    <span className="holdings-mobile-metric-sub">
                      {inv.total_units > 0.0001 ? `${formatNumber(inv.total_units, 2)} units` : '-'}
                    </span>
                  </div>
                  <div className="holdings-mobile-metric">
                    <span className="holdings-mobile-metric-label">Invested</span>
                    <span className="holdings-mobile-metric-value">{formatSensitiveAmount(netInvested, 0)}</span>
                    <span className="holdings-mobile-metric-sub">Total {formatSensitiveAmount(investedAmount, 0)}</span>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="holdings-mobile-item holdings-mobile-total">
            <div className="holdings-mobile-item-head">
              <span className="holdings-mobile-name">Total</span>
              <div className="holdings-mobile-pnl">
                <span className={`holdings-mobile-pnl-value ${profitColor(info.totalProfitLoss)}`}>
                  {formatSensitiveAmount(info.totalProfitLoss, 0)}
                </span>
                <span className={`holdings-mobile-pnl-rate ${profitColor(totalAbsPct)}`}>
                  {formatPct(totalAbsPct)} | {info.xirrPct == null ? 'N/A' : formatPct(info.xirrPct)}
                </span>
              </div>
            </div>
            <div className="holdings-mobile-metrics">
              <div className="holdings-mobile-metric">
                <span className="holdings-mobile-metric-label">Price</span>
                <span className="holdings-mobile-metric-value text-nowrap">
                  {weightedLivePrice == null ? '-' : formatWithSymbol(weightedLivePrice, weightedPriceCurrency, 2)}
                </span>
                <span className="holdings-mobile-metric-sub">Weighted</span>
              </div>
              <div className="holdings-mobile-metric">
                <span className="holdings-mobile-metric-label">1D</span>
                <span className={`holdings-mobile-metric-value ${profitColor(info.dayChange)}`}>
                  {isIntervalSwitching ? '...' : formatSensitiveAmount(info.dayChange, 0)}
                </span>
                <span className={`holdings-mobile-metric-sub ${profitColor(totalDayChangePct)}`}>
                  {isIntervalSwitching ? '...' : formatPct(totalDayChangePct)}
                </span>
                {!isIntervalSwitching && info.dayChangeFallbackCount > 0 && (
                  <span className="holdings-mobile-asof">
                    As of {info.dayChangeAsOfMixed
                      ? 'Mixed'
                      : (info.dayChangeAsOfDate ? formatAsOfDate(info.dayChangeAsOfDate) : '-')}
                  </span>
                )}
              </div>
              <div className="holdings-mobile-metric">
                <span className="holdings-mobile-metric-label">Current</span>
                <span className="holdings-mobile-metric-value">{formatSensitiveAmount(info.totalValue, 0)}</span>
                <span className="holdings-mobile-metric-sub">{formatNumber(totalUnits, 2)} units</span>
              </div>
              <div className="holdings-mobile-metric">
                <span className="holdings-mobile-metric-label">Invested</span>
                <span className="holdings-mobile-metric-value">{formatSensitiveAmount(totalCurrentInvested, 0)}</span>
                <span className="holdings-mobile-metric-sub">Total {formatSensitiveAmount(info.totalInvested, 0)}</span>
              </div>
            </div>
          </div>
        </div>

        <Card.Footer className="holdings-mobile-footer bg-white">
          Cash Proceeds: {info.totalRealizedGain >= 0 ? '+' : ''}{formatINR(info.totalRealizedGain || 0)}
        </Card.Footer>
      </Card>
    );
  }

  return (
    <Card className="shadow-sm holdings-desktop-card">
      <Card.Header className="bg-white d-flex justify-content-between align-items-center">
        <h2 className="h6 fw-semibold mb-0" title={ASSET_TYPE_FULL_NAMES[type]}>
          {(ASSET_TYPE_FULL_NAMES[type] || ASSET_TYPE_LABELS[type])} ({info.investments.length})
        </h2>
        <div className="d-flex align-items-center gap-2">
          <Link to={`/investments?type=${type}`} className="small text-decoration-none d-flex align-items-center gap-1">
            View All <ArrowRight size={12} />
          </Link>
        </div>
      </Card.Header>
      <div className="responsive-table holdings-desktop-table-wrap">
        <Table
          hover
          size="sm"
          className={`mb-0 small holdings-table${isMobile ? ' holdings-table-mobile' : ''}`}
          style={{ tableLayout: 'fixed' }}
        >
          <colgroup>
            {columnWidths.map((width, idx) => (
              <col key={`${type}-col-${idx}`} style={{ width }} />
            ))}
          </colgroup>
          <thead className="table-light">
            <tr>
              {tableColumns.map((col) => {
                const isSortable = col.key !== 'asOfDate';
                return (
                  <th
                    key={col.key}
                    className={`px-3 holdings-col-${col.key}${col.end ? ' text-end' : ''}`}
                    style={{ cursor: isSortable ? 'pointer' : 'default', userSelect: 'none' }}
                    onClick={isSortable ? () => handleSort(col.key) : undefined}
                  >
                    <div>
                      {col.label}
                      {isSortable && sortConfig?.key === col.key && (
                        <span className="ms-1" style={{ fontSize: '0.6rem' }}>
                          {sortConfig.direction === 'desc' ? '▼' : '▲'}
                        </span>
                      )}
                    </div>
                    {col.subLabel && (
                      <div className="text-muted fw-normal" style={{ fontSize: '0.68rem', lineHeight: 1.15 }}>
                        {col.subLabel}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortInvestments(info.investments).map((inv) => (
              <tr key={inv.id}>
                {(() => {
                  const investedAmount = Number(inv.invested_amount) || 0;
                  const fallbackAbsPct = investedAmount > 0
                    ? ((Number(inv.profit_loss) || 0) / investedAmount) * 100
                    : 0;
                  const rowAbsPct = Number.isFinite(Number(inv.profit_loss_pct))
                    ? Number(inv.profit_loss_pct)
                    : fallbackAbsPct;

                  return tableColumns.map((col) => {
                    if (col.key === 'name') {
                      return (
                        <td key={`${inv.id}-name`} className="px-3 holdings-col-name">
                          <Link to={`/investments/${inv.id}`} state={{ from: 'asset-type', fromLabel: ASSET_TYPE_LABELS[type] }} className="fw-medium text-decoration-none">
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
                      );
                    }

                    if (col.key === 'asOfDate') {
                      return (
                        <td key={`${inv.id}-asOfDate`} className="px-3 text-center holdings-col-asOfDate text-nowrap">
                          {inv.day_change_uses_fallback && inv.day_change_as_of_date
                            ? formatAsOfDate(inv.day_change_as_of_date)
                            : '-'}
                        </td>
                      );
                    }

                    if (col.key === 'price') {
                      const acquiredUnits = Number(inv.acquired_units) || 0;
                      const avgCostText = acquiredUnits > 0.0001
                        ? (String(inv.currency || 'INR').toUpperCase() === 'INR'
                          ? formatWithSymbol(inv.avg_cost_per_unit_native, inv.currency, 2)
                          : `${inv.avg_cost_per_unit_native == null ? `${getCurrencySymbol(inv.currency)}N/A` : formatWithSymbol(inv.avg_cost_per_unit_native, inv.currency, 2)} | ₹${formatNumber(inv.invested_amount / inv.acquired_units, 2)}`)
                        : '';
                      return (
                        <td key={`${inv.id}-price`} className="px-3 text-end holdings-col-price text-nowrap">
                          {INTEREST_RATE_ASSET_TYPES.has(inv.asset_type) ? (
                            <div className="fw-medium">
                              {Number(inv.price_per_unit) > 0 ? `${formatNumber(inv.price_per_unit, 2)}%` : '-'}
                            </div>
                          ) : (
                            <div className="fw-medium">{formatWithSymbol(inv.price_per_unit, inv.currency, 2)}</div>
                          )}
                          <div className="text-muted" style={{ fontSize: '0.7rem' }}>{avgCostText}</div>
                          {isMobile && (
                            <div className="holdings-mobile-extra text-nowrap">
                              Val {formatSensitiveAmount(inv.current_value, 0)}
                            </div>
                          )}
                        </td>
                      );
                    }

                    if (col.key === 'dayChange') {
                      return (
                        <td key={`${inv.id}-dayChange`} className="px-3 text-end holdings-col-dayChange">
                          {isIntervalSwitching ? (
                            <>
                              <div className="fw-medium text-muted">...</div>
                              <div className="text-muted" style={{ fontSize: '0.7rem' }}>...</div>
                            </>
                          ) : (
                            <>
                              <div className={`fw-medium ${profitColor(inv.day_change)}`}>{formatSensitiveAmount(inv.day_change, 0)}</div>
                              <div className={profitColor(inv.day_change_pct)} style={{ fontSize: '0.7rem' }}>
                                {formatPct(inv.day_change_pct)}
                              </div>
                              {isMobile && (
                                <div className="holdings-mobile-extra text-nowrap">
                                  Inv {formatSensitiveAmount((Number(inv.invested_amount) || 0) - (Number(inv.realized_proceeds) || 0), 0)}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                      );
                    }

                    if (col.key === 'totalCost') {
                      return (
                        <td key={`${inv.id}-totalCost`} className="px-3 text-end holdings-col-totalCost text-nowrap">
                          <div className="fw-medium">{formatSensitiveAmount((Number(inv.invested_amount) || 0) - (Number(inv.realized_proceeds) || 0), 0)}</div>
                          <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                            {formatSensitiveAmount(inv.invested_amount, 0)}
                          </div>
                        </td>
                      );
                    }

                    if (col.key === 'currentValue') {
                      return (
                        <td key={`${inv.id}-currentValue`} className="px-3 text-end holdings-col-currentValue text-nowrap">
                          <div className="fw-medium">{formatSensitiveAmount(inv.current_value, 0)}</div>
                          <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                            {inv.total_units > 0.0001 ? `${formatNumber(inv.total_units, 4)} Units` : ''}
                          </div>
                        </td>
                      );
                    }

                    if (col.key === 'portfolioPct') {
                      return (
                        <td key={`${inv.id}-portfolioPct`} className="px-3 text-end holdings-col-portfolioPct">
                          <div className="fw-medium">{(inv.portfolio_pct || 0).toFixed(2)}%</div>
                          <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                            {info.totalValue > 0 ? (((inv.current_value || 0) / info.totalValue) * 100).toFixed(2) : '0.00'}%
                          </div>
                        </td>
                      );
                    }

                    if (col.key === 'totalReturn') {
                      return (
                        <td key={`${inv.id}-totalReturn`} className="px-3 text-end holdings-col-totalReturn">
                          <div className={`fw-semibold ${profitColor(inv.profit_loss)}`}>
                            {formatSensitiveAmount(inv.profit_loss, 0)}
                          </div>
                          <div className={profitColor(rowAbsPct)} style={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                            {isMobile
                              ? `${formatPct(rowAbsPct)}|${inv.xirr_pct == null ? 'N/A' : formatPct(inv.xirr_pct)}`
                              : `${formatPct(rowAbsPct)} | ${inv.xirr_pct == null ? 'N/A' : formatPct(inv.xirr_pct)}`}
                          </div>
                        </td>
                      );
                    }

                    return null;
                  });
                })()}
              </tr>
            ))}
            <tr className="table-light fw-semibold">
              {tableColumns.map((col) => {
                if (col.key === 'name') {
                  return <td key={`${type}-total-name`} className="px-3 holdings-col-name">Total</td>;
                }

                if (col.key === 'asOfDate') {
                  return (
                    <td key={`${type}-total-asOfDate`} className="px-3 text-center holdings-col-asOfDate text-nowrap">
                      {info.dayChangeFallbackCount > 0
                        ? (info.dayChangeAsOfMixed
                          ? 'Mixed'
                          : (info.dayChangeAsOfDate ? formatAsOfDate(info.dayChangeAsOfDate) : '-'))
                        : '-'}
                    </td>
                  );
                }

                if (col.key === 'price') {
                  return (
                    <td key={`${type}-total-price`} className="px-3 text-end holdings-col-price text-nowrap">
                      {INTEREST_RATE_ASSET_TYPES.has(type) ? (
                        <>
                          <div className="fw-medium">-</div>
                          {!isMobile && (
                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>{latestTypeDate ? formatDate(latestTypeDate) : ''}</div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="fw-medium">
                            {weightedLivePrice == null
                              ? '-'
                              : formatWithSymbol(weightedLivePrice, weightedPriceCurrency, 2)}
                          </div>
                          {isMobile ? (
                            <div className="holdings-mobile-extra text-nowrap">
                              Val {formatSensitiveAmount(info.totalValue, 0)}
                            </div>
                          ) : (
                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                              {weightedAvgCostPerUnit == null
                                ? ''
                                : formatWithSymbol(weightedAvgCostPerUnit, weightedPriceCurrency, 2)}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  );
                }

                if (col.key === 'dayChange') {
                  return (
                    <td key={`${type}-total-dayChange`} className="px-3 text-end holdings-col-dayChange">
                      {isIntervalSwitching ? (
                        <>
                          <div className="fw-medium text-muted">...</div>
                          <div className="text-muted" style={{ fontSize: '0.7rem' }}>...</div>
                        </>
                      ) : (
                        <>
                          <div className={`fw-medium ${profitColor(info.dayChange)}`}>{formatSensitiveAmount(info.dayChange, 0)}</div>
                          <div className={profitColor(totalDayChangePct)} style={{ fontSize: '0.7rem' }}>
                            {formatPct(totalDayChangePct)}
                          </div>
                          {isMobile && (
                            <div className="holdings-mobile-extra text-nowrap">
                              Inv {formatSensitiveAmount(totalCurrentInvested, 0)}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  );
                }

                if (col.key === 'totalCost') {
                  return (
                    <td key={`${type}-total-totalCost`} className="px-3 text-end holdings-col-totalCost text-nowrap">
                      <div className="fw-medium">{formatSensitiveAmount(totalCurrentInvested, 0)}</div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                        {formatSensitiveAmount(info.totalInvested, 0)}
                      </div>
                    </td>
                  );
                }

                if (col.key === 'currentValue') {
                  return (
                    <td key={`${type}-total-currentValue`} className="px-3 text-end holdings-col-currentValue text-nowrap">
                      <div className="fw-medium">{formatSensitiveAmount(info.totalValue, 0)}</div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                        {totalUnits > 0.0001 ? `${formatNumber(totalUnits, 4)} Units` : ''}
                      </div>
                    </td>
                  );
                }

                if (col.key === 'portfolioPct') {
                  return (
                    <td key={`${type}-total-portfolioPct`} className="px-3 text-end holdings-col-portfolioPct">
                      <div className="fw-medium">
                        {portfolioTotalValue > 0 ? ((info.totalValue / portfolioTotalValue) * 100).toFixed(2) : '0.00'}%
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>100.00%</div>
                    </td>
                  );
                }

                if (col.key === 'totalReturn') {
                  return (
                    <td key={`${type}-total-totalReturn`} className={`px-3 text-end holdings-col-totalReturn ${profitColor(info.totalProfitLoss)}`}>
                      <div className="fw-semibold">
                        {formatSensitiveAmount(info.totalProfitLoss, 0)}
                      </div>
                      <div className={profitColor(totalAbsPct)} style={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                        {isMobile
                          ? `${formatPct(totalAbsPct)}|${info.xirrPct == null ? 'N/A' : formatPct(info.xirrPct)}`
                          : `${formatPct(totalAbsPct)} | ${info.xirrPct == null ? 'N/A' : formatPct(info.xirrPct)}`}
                      </div>
                    </td>
                  );
                }

                return null;
              })}
            </tr>
          </tbody>
        </Table>
      </div>
      <Card.Footer className="bg-white border-top-0 pt-0">
        <div className="small text-muted text-end">
          Cash Proceeds: {info.totalRealizedGain >= 0 ? '+' : ''}{formatINR(info.totalRealizedGain || 0)}
        </div>
      </Card.Footer>
    </Card>
  );
}
