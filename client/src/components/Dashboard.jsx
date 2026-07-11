import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Row, Col, Table, Spinner, Alert, Button } from 'react-bootstrap';
import { getDashboardSummary, getDailyValuesHealthStatus, getDashboardBatch } from '../services/api';
import { getOpenGaps, getComplianceStatus } from '../services/compliance';
import { ComplianceWarning } from './ComplianceWarning';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS, ASSET_TYPE_FULL_NAMES, ASSET_TYPE_DISPLAY_ORDER } from '../utils/formatters';
import { TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowRight, AlertTriangle, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';
import { useAppSettings } from '../context/AppSettingsContext';
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import DashboardRolloverTable from './DashboardRolloverTable';

function AllocationChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #dee2e6',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: '0.75rem',
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
      }}
    >
      <div style={{ fontWeight: 600 }}>{datum.fullName}</div>
      <div>{formatINR(datum.value)} · {Number(datum.pct || 0).toFixed(1)}%</div>
    </div>
  );
}

const INTEREST_RATE_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);
const DASHBOARD_CACHE_TTL_MS = 2 * 60 * 1000;
const MOBILE_BREAKPOINT_PX = 768;
const dashboardSummaryCache = new Map();

function getDashboardCacheKey({
  targetPortfolioId,
  hideSold,
  includeFullySoldInReturns,
  selectedInterval,
  customFromDate,
  customToDate,
}) {
  return JSON.stringify({
    targetPortfolioId: targetPortfolioId ?? null,
    hideSold: !!hideSold,
    includeFullySoldInReturns: !!includeFullySoldInReturns,
    selectedInterval: selectedInterval || '1D',
    customFromDate: customFromDate || null,
    customToDate: customToDate || null,
  });
}

function getCachedDashboardSummary(cacheKey) {
  const cached = dashboardSummaryCache.get(cacheKey);
  if (!cached) return null;
  if ((Date.now() - cached.ts) > DASHBOARD_CACHE_TTL_MS) {
    dashboardSummaryCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function setCachedDashboardSummary(cacheKey, data) {
  if (!data) return;
  dashboardSummaryCache.set(cacheKey, {
    ts: Date.now(),
    data,
  });
}

function sortAssetTypeEntries(byType) {
  return Object.entries(byType || {}).sort(([typeA], [typeB]) => {
    const orderA = ASSET_TYPE_DISPLAY_ORDER[typeA] ?? 999;
    const orderB = ASSET_TYPE_DISPLAY_ORDER[typeB] ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return String(typeA).localeCompare(String(typeB));
  });
}

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

function combineHealthStatuses(results) {
  if (!Array.isArray(results) || !results.length) return null;

  const merged = {
    run_date: results.map((r) => r?.run_date).filter(Boolean).sort().at(-1) || null,
    status: 'ok',
    counts: {
      scopes_checked: 0,
      issue_scopes: 0,
      compliance_errors: 0,
      missing_rows: 0,
      unexpected_locf: 0,
      pending_locf: 0,
      overdue_locf: 0,
      stale_scopes: 0,
      pending_dirty_scopes: 0,
      prewarn_scopes: 0,
    },
    compliance: {
      runDate: null,
      scanFloor: null,
      dirtyFrom: null,
      openGapCount: 0,
      hasBacklog: false,
      lastScan: {
        mode: null,
        runDate: null,
        gapsDetected: 0,
        repairsEnqueued: 0,
      },
    },
    issues: [],
  };

  for (const result of results) {
    if (!result) continue;
    const counts = result.counts || {};
    merged.counts.scopes_checked += Number(counts.scopes_checked || 0);
    merged.counts.issue_scopes += Number(counts.issue_scopes || 0);
    merged.counts.compliance_errors += Number(counts.compliance_errors || 0);
    merged.counts.missing_rows += Number(counts.missing_rows || 0);
    merged.counts.unexpected_locf += Number(counts.unexpected_locf || 0);
    merged.counts.pending_locf += Number(counts.pending_locf || 0);
    merged.counts.overdue_locf += Number(counts.overdue_locf || 0);
    merged.counts.stale_scopes += Number(counts.stale_scopes || 0);
    merged.counts.pending_dirty_scopes += Number(counts.pending_dirty_scopes || 0);
    merged.counts.prewarn_scopes += Number(counts.prewarn_scopes || 0);

    const compliance = result.compliance || {};
    merged.compliance.runDate = [merged.compliance.runDate, compliance.runDate]
      .filter(Boolean)
      .sort()
      .at(-1) || merged.compliance.runDate;
    merged.compliance.openGapCount = Math.max(
      Number(merged.compliance.openGapCount || 0),
      Number(compliance.openGapCount || 0)
    );
    merged.compliance.hasBacklog = merged.compliance.hasBacklog || !!compliance.hasBacklog;

    if (compliance.scanFloor && (!merged.compliance.scanFloor || compliance.scanFloor < merged.compliance.scanFloor)) {
      merged.compliance.scanFloor = compliance.scanFloor;
    }
    if (compliance.dirtyFrom && (!merged.compliance.dirtyFrom || compliance.dirtyFrom < merged.compliance.dirtyFrom)) {
      merged.compliance.dirtyFrom = compliance.dirtyFrom;
    }

    const resultLastScan = compliance.lastScan || {};
    const mergedLastScan = merged.compliance.lastScan || {};
    const mergedLastRun = mergedLastScan.runDate || '';
    const resultLastRun = resultLastScan.runDate || '';
    if (resultLastRun >= mergedLastRun) {
      merged.compliance.lastScan = {
        mode: resultLastScan.mode || null,
        runDate: resultLastRun || null,
        gapsDetected: Number(resultLastScan.gapsDetected || 0),
        repairsEnqueued: Number(resultLastScan.repairsEnqueued || 0),
      };
    }

    if (Array.isArray(result.issues)) merged.issues.push(...result.issues);
  }

  if (merged.counts.missing_rows > 0 || merged.counts.compliance_errors > 0) merged.status = 'error';
  else if (merged.counts.unexpected_locf > 0 || merged.counts.stale_scopes > 0 || merged.counts.pending_dirty_scopes > 0) merged.status = 'warning';

  merged.issues.sort((a, b) => {
    if ((b.missing_count || 0) !== (a.missing_count || 0)) {
      return (b.missing_count || 0) - (a.missing_count || 0);
    }
    return (b.unexpected_locf_count || 0) - (a.unexpected_locf_count || 0);
  });

  return merged;
}

function mergeXirrEnrichment(baseData, enrichedData) {
  if (!baseData) return enrichedData;
  if (!enrichedData) return baseData;

  const xirrByInvestmentId = new Map(
    (enrichedData.investments || []).map((inv) => [Number(inv.id), inv.xirr_pct ?? null])
  );

  const mergedInvestments = (baseData.investments || []).map((inv) => {
    const nextXirr = xirrByInvestmentId.has(Number(inv.id))
      ? xirrByInvestmentId.get(Number(inv.id))
      : (inv.xirr_pct ?? null);
    if ((inv.xirr_pct ?? null) === nextXirr) return inv;
    return {
      ...inv,
      xirr_pct: nextXirr,
    };
  });

  const investmentsByType = mergedInvestments.reduce((acc, inv) => {
    if (!acc[inv.asset_type]) acc[inv.asset_type] = [];
    acc[inv.asset_type].push(inv);
    return acc;
  }, {});

  const mergedByType = {};
  for (const [type, info] of Object.entries(baseData.byType || {})) {
    mergedByType[type] = {
      ...info,
      investments: investmentsByType[type] || info.investments || [],
      xirrPct: enrichedData.byType?.[type]?.xirrPct ?? info.xirrPct ?? null,
    };
  }

  for (const [type, info] of Object.entries(enrichedData.byType || {})) {
    if (mergedByType[type]) continue;
    mergedByType[type] = {
      ...info,
      investments: investmentsByType[type] || info.investments || [],
    };
  }

  return {
    ...baseData,
    portfolio: {
      ...(baseData.portfolio || {}),
      xirr_pct: enrichedData.portfolio?.xirr_pct ?? baseData.portfolio?.xirr_pct ?? null,
    },
    investments: mergedInvestments,
    byType: mergedByType,
  };
}

export default function Dashboard() {
  const { selectedId, selectedIds, selectedPortfolio } = usePortfolio();
  const { settings, loading: settingsLoading } = useAppSettings();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [sortConfigs, setSortConfigs] = useState({});
  const [dailyHealth, setDailyHealth] = useState(null);
  const [showHealthDetails, setShowHealthDetails] = useState(false);
  const [dismissedBanners, setDismissedBanners] = useState({});
  const [complianceGaps, setComplianceGaps] = useState([]);
  const [complianceStatus, setComplianceStatus] = useState(null);
  const [complianceLoading, setComplianceLoading] = useState(false);
  const [showDetailTables, setShowDetailTables] = useState(false);
  const [isIntervalSwitching, setIsIntervalSwitching] = useState(false);
  const [selectedInterval, setSelectedInterval] = useState('1D');
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [customFromDate, setCustomFromDate] = useState('');
  const [customToDate, setCustomToDate] = useState('');
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth < MOBILE_BREAKPOINT_PX : false),
  );
  const loadRunRef = useRef(0);
  const lastLoadedIntervalSigRef = useRef(null);
  const selectedIdsKey = (selectedIds || []).join(',');

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

  const hideSold = settings.hideSoldInvestments;
  const includeFullySoldInReturns = hideSold ? settings.includeFullySoldInReturns : true;

  useEffect(() => {
    loadData();
  }, [selectedId, selectedIdsKey, hideSold, includeFullySoldInReturns, settingsLoading, selectedInterval, customFromDate, customToDate]);

  useEffect(() => {
    if (settingsLoading) return undefined;
    const runId = loadRunRef.current;
    const timeoutId = setTimeout(() => {
      if (runId === loadRunRef.current) {
        // Parallel load: health + compliance together
        Promise.all([
          (async () => {
            try {
              if (selectedIds.length > 1) {
                const healthResults = await Promise.all(selectedIds.map((id) => getDailyValuesHealthStatus(id).catch(() => null)));
                if (runId !== loadRunRef.current) return;
                setDailyHealth(combineHealthStatuses(healthResults.filter(Boolean)));
              } else {
                const health = await getDailyValuesHealthStatus(selectedId).catch(() => null);
                if (runId !== loadRunRef.current) return;
                setDailyHealth(health);
              }
            } catch {
              if (runId !== loadRunRef.current) return;
              setDailyHealth(null);
            }
          })(),
          (async () => {
            try {
              setComplianceLoading(true);
              const [gapsResult, statusResult] = await Promise.all([
                getOpenGaps().catch(() => ({ gaps: [] })),
                getComplianceStatus().catch(() => null),
              ]);
              if (runId !== loadRunRef.current) return;
              setComplianceGaps(gapsResult?.gaps || []);
              setComplianceStatus(statusResult);
            } catch (e) {
              console.error('Compliance check failed:', e);
            } finally {
              if (runId !== loadRunRef.current) return;
              setComplianceLoading(false);
            }
          })(),
        ]);
      }
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [selectedId, selectedIdsKey, settingsLoading]);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#section-')) return;
    const sectionId = hash.slice(1);
    const raf = window.requestAnimationFrame(() => {
      scrollToSection(sectionId, { smooth: false, updateHash: false });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [data, scrollToSection]);

  useEffect(() => {
    const updateIsMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    };

    updateIsMobile();
    window.addEventListener('resize', updateIsMobile);
    return () => window.removeEventListener('resize', updateIsMobile);
  }, []);

  const loadComplianceStatus = async () => {
    try {
      setComplianceLoading(true);
      const [gapsResult, statusResult] = await Promise.all([
        getOpenGaps().catch(() => ({ gaps: [] })),
        getComplianceStatus().catch(() => null),
      ]);
      setComplianceGaps(gapsResult?.gaps || []);
      setComplianceStatus(statusResult);
    } catch (e) {
      console.error('Compliance check failed:', e);
    } finally {
      setComplianceLoading(false);
    }
  };

  const loadData = async () => {
    const runId = ++loadRunRef.current;
    if (settingsLoading) return;
    if (selectedInterval === 'CUSTOM' && (!customFromDate || !customToDate)) return;
    const intervalSig = `${selectedInterval}|${customFromDate || ''}|${customToDate || ''}`;
    const isIntervalRefresh = lastLoadedIntervalSigRef.current != null
      && lastLoadedIntervalSigRef.current !== intervalSig;
    if (isIntervalRefresh) setIsIntervalSwitching(true);
    const showBlockingLoader = !data;
    const targetPortfolioId = selectedIds.length > 1 ? null : selectedId;
    const cacheKey = getDashboardCacheKey({
      targetPortfolioId,
      hideSold,
      includeFullySoldInReturns,
      selectedInterval,
      customFromDate,
      customToDate,
    });
    const cachedSummary = getCachedDashboardSummary(cacheKey);

    try {
      if (showBlockingLoader) setLoading(true);
      else setRefreshing(true);
      setShowHealthDetails(false);

      if (showBlockingLoader && cachedSummary) {
        setData(cachedSummary);
        setLoading(false);
        setShowDetailTables(true);
      }

      if (showBlockingLoader && !cachedSummary) {
        setShowDetailTables(false);
        const fastResult = await getDashboardSummary(targetPortfolioId, {
          hideSold,
          includeFullySoldInReturns,
          xirrMode: 'portfolio_only',
          interval: selectedInterval,
          customFromDate: customFromDate || undefined,
          customToDate: customToDate || undefined,
        });
        if (runId !== loadRunRef.current) return;
        setData(fastResult);
        setCachedDashboardSummary(cacheKey, fastResult);
        setLoading(false);

        await new Promise((resolve) => {
          if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => resolve(), { timeout: 2000 });
          } else {
            setTimeout(resolve, 350);
          }
        });
        if (runId !== loadRunRef.current) return;
        setShowDetailTables(true);

        const fullResult = await getDashboardSummary(targetPortfolioId, {
          hideSold,
          includeFullySoldInReturns,
          xirrMode: 'full',
          interval: selectedInterval,
          customFromDate: customFromDate || undefined,
          customToDate: customToDate || undefined,
        });
        if (runId !== loadRunRef.current) return;
        setData((prev) => {
          const merged = mergeXirrEnrichment(prev, fullResult);
          setCachedDashboardSummary(cacheKey, merged);
          return merged;
        });
      } else {
        const result = await getDashboardSummary(targetPortfolioId, {
          hideSold,
          includeFullySoldInReturns,
          xirrMode: 'full',
          interval: selectedInterval,
          customFromDate: customFromDate || undefined,
          customToDate: customToDate || undefined,
        });
        if (runId !== loadRunRef.current) return;
        setData(result);
        setCachedDashboardSummary(cacheKey, result);
        setShowDetailTables(true);
      }

      setError(null);
      lastLoadedIntervalSigRef.current = intervalSig;
    } catch (e) {
      if (runId !== loadRunRef.current) return;
      setError(e.message);
    } finally {
      if (runId !== loadRunRef.current) return;
      setLoading(false);
      setRefreshing(false);
      setIsIntervalSwitching(false);
    }
  };

  const loadDailyHealth = async () => {
    const runId = loadRunRef.current;
    try {
      if (selectedIds.length > 1) {
        const healthResults = await Promise.all(selectedIds.map((id) => getDailyValuesHealthStatus(id).catch(() => null)));
        if (runId !== loadRunRef.current) return;
        setDailyHealth(combineHealthStatuses(healthResults.filter(Boolean)));
      } else {
        const health = await getDailyValuesHealthStatus(selectedId).catch(() => null);
        if (runId !== loadRunRef.current) return;
        setDailyHealth(health);
      }
    } catch {
      if (runId !== loadRunRef.current) return;
      setDailyHealth(null);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!data) return null;

  const { portfolio, investments, byType, lastUpdate, portfolioCount, totalExpenses, rollupWarning, stalePricesWarning } = data;
  const netProfitLoss = portfolio.total_profit_loss - (totalExpenses || 0);
  const netReturnPct = portfolio.total_invested > 0 ? (netProfitLoss / portfolio.total_invested) * 100 : 0;
  const totalRealizedGain = Number(portfolio.total_realized_proceeds) || 0;
  const currentInvested = (Number(portfolio.total_invested) || 0) - totalRealizedGain;
  const formatINRExact = (amount) => {
    if (amount == null || Number.isNaN(Number(amount))) return '₹0';
    const value = Number(amount);
    const sign = value < 0 ? '-' : '';
    return `${sign}₹${Math.abs(value).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  };

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

  const formatAsOfDate = (dateValue) => {
    const formatted = formatDate(dateValue);
    if (!formatted) return formatted;
    return formatted.replace(/-\d{4}$/, '');
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

  const isDayChangeMode = selectedInterval === '1D' || selectedInterval === 'YD';

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
    { key: 'asOfDate', label: 'As Of', subLabel: 'Date' },
    { key: 'price', label: 'Last Price', subLabel: 'Avg Cost / Unit', end: true },
    {
      key: 'dayChange',
      label: '1D',
      subLabel: '% Change',
      end: true,
    },
    { key: 'totalReturn', label: 'Total P&L', subLabel: 'Abs | XIRR', end: true },
  ];

  const getSortColumnsForType = (type) => {
    if (!INTEREST_RATE_ASSET_TYPES.has(type)) return baseSortColumns;
    return baseSortColumns.map((col) => {
      if (col.key !== 'price') return col;
      return {
        ...col,
        label: 'Interest Rate',
        subLabel: 'As Of Date',
      };
    });
  };

  const tableColumnWidths = ['30%', '11.5%', '11.5%', '11.5%', '11.5%', '9%', '15%'];
  const tableColumnWidthsWithAsOfDate = ['26%', '10%', '10.5%', '10.5%', '10.5%', '10.5%', '9%', '13%'];
  const mobileTableColumnWidths = ['31%', '14%', '17%', '16%', '22%'];

  const complianceSnapshot = dailyHealth?.compliance || complianceStatus?.compliance || null;
  const isBannerDismissed = (id, signature) => dismissedBanners[id] === signature;
  const dismissBanner = (id, signature) => setDismissedBanners((prev) => ({ ...prev, [id]: signature }));
  const rollupBannerSig = rollupWarning
    ? `rollup:${rollupWarning.maxDate || '-'}:${rollupWarning.portfoliosCovered || 0}/${rollupWarning.portfoliosTotal || 0}`
    : null;
  const healthBannerSig = dailyHealth
    ? `health:${dailyHealth.status}:${JSON.stringify(dailyHealth.counts || {})}`
    : null;
  const staleBannerSig = stalePricesWarning
    ? `stale:${stalePricesWarning.latestDate || '-'}`
    : null;
  const sortedAssetEntries = sortAssetTypeEntries(byType);
  const allocationChartData = sortedAssetEntries
    .map(([type, info]) => ({
      type,
      name: ASSET_TYPE_LABELS[type] || type,
      fullName: ASSET_TYPE_FULL_NAMES[type] || ASSET_TYPE_LABELS[type] || type,
      value: Number(info.totalValue) || 0,
    }))
    .filter((datum) => datum.value > 0);
  const allocationChartTotal = allocationChartData.reduce((sum, datum) => sum + datum.value, 0);
  allocationChartData.forEach((datum) => {
    datum.pct = allocationChartTotal > 0 ? (datum.value / allocationChartTotal) * 100 : 0;
  });
  const selectedIntervalLabel = selectedInterval === 'CUSTOM' ? 'Cust' : selectedInterval;
  const hasRecordedComplianceScan = !!(
    complianceSnapshot?.lastScan?.mode
    || complianceSnapshot?.lastScan?.runDate
    || complianceSnapshot?.scanFloor
  );
  const prewarnScopes = Number(dailyHealth?.counts?.prewarn_scopes || 0);
  const complianceIndicator = dailyHealth?.status === 'error'
    ? { icon: ShieldX, tone: 'error', title: 'Compliance error' }
    : dailyHealth?.status === 'warning'
      ? { icon: ShieldAlert, tone: 'warning', title: 'Compliance warning' }
      : prewarnScopes > 0
        ? { icon: ShieldAlert, tone: 'warning', title: 'Compliance pre-warning' }
        : { icon: ShieldCheck, tone: 'healthy', title: 'Compliance healthy' };
  const ComplianceIcon = complianceIndicator.icon;

  return (
    <div className="dashboard-page">
      <div className={`dashboard-header mb-4 ${selectedPortfolio ? '' : 'dashboard-header-no-title'}`}>
        {selectedPortfolio ? (
          <div className="dashboard-title-row d-flex align-items-center gap-2">
            <span className="portfolio-dot" style={{ backgroundColor: selectedPortfolio.color }} />
            <h1 className="h4 fw-bold mb-0">{selectedPortfolio.name}</h1>
          </div>
        ) : null}
        <div className="dashboard-header-meta">
          {lastUpdate && (
            <span className="dashboard-last-updated">
              Updated {formatDate(lastUpdate)} {new Date(lastUpdate).toLocaleTimeString('en-IN')}
            </span>
          )}
          <span
            className={`dashboard-compliance-indicator dashboard-compliance-${complianceIndicator.tone}`}
            title={complianceIndicator.title}
            aria-label={complianceIndicator.title}
          >
            <ComplianceIcon size={16} />
          </span>
        </div>
      </div>

      {refreshing && (
        <div className="text-muted small mb-2 d-flex align-items-center gap-2">
          <Spinner animation="border" size="sm" />
          Refreshing dashboard...
        </div>
      )}

      <ComplianceWarning gaps={complianceGaps} loading={complianceLoading} />

      {rollupWarning && !isBannerDismissed('rollup', rollupBannerSig) && (
        <Alert
          variant="warning"
          className="py-2 mb-4"
          dismissible
          onClose={() => dismissBanner('rollup', rollupBannerSig)}
        >
          <div className="d-flex align-items-center gap-2">
            <AlertTriangle size={16} />
            <span className="fw-semibold">Rollup date alignment warning</span>
          </div>
          <div className="small mt-1">
            {rollupWarning.message} Latest rollup date: {rollupWarning.maxDate || '-'}; covered portfolios: {rollupWarning.portfoliosCovered || 0}/{rollupWarning.portfoliosTotal || 0}.
          </div>
        </Alert>
      )}

      {dailyHealth && dailyHealth.status !== 'ok' && !isBannerDismissed('health', healthBannerSig) && (
        <Alert
          variant={dailyHealth.status === 'error' ? 'danger' : 'warning'}
          className="py-2 mb-4 dashboard-health-alert"
          dismissible
          onClose={() => dismissBanner('health', healthBannerSig)}
        >
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div className="d-flex align-items-center gap-2">
              <AlertTriangle size={16} />
              <span className="fw-semibold">Daily values health warning</span>
              <span className="small d-none d-md-inline">
                Missing: {dailyHealth.counts?.missing_rows || 0} | Compliance errors: {dailyHealth.counts?.compliance_errors || 0} | Unexpected LOCF: {dailyHealth.counts?.unexpected_locf || 0} | Pending LOCF: {dailyHealth.counts?.pending_locf || 0} | Stale scopes: {dailyHealth.counts?.stale_scopes || 0}
              </span>
              <span className="small d-inline d-md-none">
                Missing {dailyHealth.counts?.missing_rows || 0} | Errors {dailyHealth.counts?.compliance_errors || 0}
              </span>
            </div>
            <Button
              size="sm"
              variant={dailyHealth.status === 'error' ? 'outline-danger' : 'outline-warning'}
              onClick={() => setShowHealthDetails((prev) => !prev)}
            >
              {showHealthDetails ? 'Hide details' : 'Show details'}
            </Button>
          </div>
          <div className="small mt-2 d-none d-md-block">
            <span className="fw-semibold">Compliance:</span>{' '}
            {hasRecordedComplianceScan ? (
              <>
                Dirty from {complianceSnapshot?.dirtyFrom || '-'} |{' '}
                Open gaps {complianceSnapshot?.openGapCount || 0} |{' '}
                Backlog {complianceSnapshot?.hasBacklog ? 'yes' : 'no'}
              </>
            ) : (
              <>
                No compliance scan recorded yet |{' '}
                Dirty from {complianceSnapshot?.dirtyFrom || '-'} |{' '}
                Open gaps {complianceSnapshot?.openGapCount || 0} |{' '}
                Backlog {complianceSnapshot?.hasBacklog ? 'yes' : 'no'}
              </>
            )}
          </div>
          {showHealthDetails && (
            <div className="mt-2 responsive-table">
              <Table size="sm" className="mb-0">
                <thead>
                  <tr>
                    <th>Investment</th>
                    <th>Portfolio</th>
                    <th>First Missing</th>
                    <th>Dirty From</th>
                    <th>First LOCF</th>
                    <th className="text-end">LOCF Count</th>
                  </tr>
                </thead>
                <tbody>
                  {(dailyHealth.issues || []).slice(0, 12).map((issue) => (
                    <tr key={`${issue.investment_id}-${issue.portfolio_id}`}>
                      <td>
                        <Link to={`/investments/${issue.investment_id}`} className="text-decoration-none">
                          {issue.investment_name}
                        </Link>
                      </td>
                      <td>{issue.portfolio_name || '-'}</td>
                      <td>{issue.first_missing_date || '-'}</td>
                      <td>{issue.dirty_from_date || '-'}</td>
                      <td>{issue.first_locf_warning_date || '-'}</td>
                      <td className="text-end">{issue.locf_warning_count || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Alert>
      )}

      {stalePricesWarning && !isBannerDismissed('stale', staleBannerSig) && (
        <Alert
          variant="warning"
          className="py-2 mb-4"
          dismissible
          onClose={() => dismissBanner('stale', staleBannerSig)}
        >
          <div className="d-flex align-items-center gap-2">
            <AlertTriangle size={16} />
            <span className="fw-semibold">Data is outdated</span>
          </div>
          <div className="small mt-1">
            {stalePricesWarning.message}
          </div>
        </Alert>
      )}

      {/* Portfolio Summary Cards */}
      <Row className="g-3 mb-4">
        <Col md={6} lg={4}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <Wallet size={16} /> Current Value
              </div>
              <div className="fw-bold" style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>{formatINRExact(portfolio.total_value)}</div>
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
                  {(data?.intervalXIRR?.interval_change ?? 0) >= 0 ? (
                    <TrendingUp size={16} className="text-success" />
                  ) : (
                    <TrendingDown size={16} className="text-danger" />
                  )}
                  <span>
                    {selectedInterval === 'CUSTOM'
                      ? `${customFromDate} to ${customToDate}`
                      : selectedInterval === '1D'
                      ? '1 Day Change'
                      : selectedInterval === 'YD'
                      ? 'Yesterday Change'
                      : `${selectedInterval} Change`}
                  </span>
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
                    disabled={!!stalePricesWarning}
                    title={stalePricesWarning ? 'Please update prices first' : ''}
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
                  <div className={`fs-3 fw-bold ${profitColor(data?.intervalXIRR?.interval_change)}`}>
                    {formatINR(data?.intervalXIRR?.interval_change || 0)}
                  </div>
                  {isDayChangeMode ? (
                    <div className={`small ${profitColor(data?.intervalXIRR?.interval_change_pct)}`}>
                      Change: {formatPct(data?.intervalXIRR?.interval_change_pct || 0)}
                    </div>
                  ) : data?.intervalXIRR?.xirr_pct != null ? (
                    <div className={`small ${profitColor(data.intervalXIRR.xirr_pct)}`}>
                      Change: {formatPct(data.intervalXIRR.xirr_pct)} p.a.
                    </div>
                  ) : (
                    <div className="small text-warning" title={data?.intervalXIRR?.error || 'XIRR could not be calculated for this interval'}>
                      ⚠ XIRR unavailable
                    </div>
                  )}
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
                <span>XIRR: {portfolio.xirr_pct == null ? 'N/A' : formatPct(portfolio.xirr_pct)}</span>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Asset Allocation */}
      <Card className="shadow-sm mb-4 asset-allocation-section">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">Asset Allocation</h2>
          <div className="asset-allocation-grid">
            {sortedAssetEntries.map(([type, info]) => (
              <div className="asset-allocation-grid-item" key={type}>
                {(() => {
                  const intervalChangePct = Number(info.intervalChangePct ?? 0);
                  const intervalPctSuffix = isDayChangeMode ? '' : ' p.a.';
                  const lifetimeClass = profitColor(info.totalProfitLoss);
                  const intervalClass = profitColor(info.dayChange);
                  const allocationPct = portfolio.total_value > 0
                    ? (info.totalValue / portfolio.total_value) * 100
                    : 0;

                  return (
                <div
                  className="rounded p-2 border asset-allocation-card"
                  style={{ borderLeftColor: ASSET_TYPE_COLORS[type], borderLeftWidth: '4px', borderLeftStyle: 'solid' }}
                >
                  <span
                    className="asset-allocation-pct"
                    title={`${ASSET_TYPE_FULL_NAMES[type] || ASSET_TYPE_LABELS[type]} is ${allocationPct.toFixed(1)}% of total current value`}
                  >
                    {allocationPct.toFixed(1)}%
                  </span>
                  <Link
                    to={`/asset-types/${type}`}
                    className="text-decoration-underline fw-semibold"
                    style={{ fontSize: '0.95rem', color: ASSET_TYPE_COLORS[type] || '#6c757d' }}
                    title={ASSET_TYPE_FULL_NAMES[type]}
                  >
                    {ASSET_TYPE_LABELS[type]} ↓
                  </Link>
                  <div className="fw-semibold text-nowrap" style={{ fontSize: '1.05rem' }}>{formatINR(info.totalValue)}</div>
                  <div className="asset-metric-line">
                    <span className="asset-metric-label">LT:</span>
                    <span className={`asset-metric-value ${lifetimeClass}`}>
                      {info.totalProfitLoss >= 0 ? '+' : ''}{formatINR(info.totalProfitLoss)}
                    </span>
                    <span className="asset-metric-separator">·</span>
                    <span className={`asset-metric-rate ${lifetimeClass}`}>
                      {info.xirrPct == null ? 'N/A' : formatPct(info.xirrPct)}
                    </span>
                  </div>
                  <div className="asset-metric-line">
                    <span className="asset-metric-label">{selectedIntervalLabel}:</span>
                    {isIntervalSwitching ? (
                      <>
                        <span className="asset-metric-value text-muted">Updating...</span>
                        <span className="asset-metric-separator">·</span>
                        <span className="asset-metric-rate text-muted">...</span>
                      </>
                    ) : (
                      <>
                        <span className={`asset-metric-value ${intervalClass}`}>
                          {info.dayChange >= 0 ? '+' : ''}{formatINR(info.dayChange)}
                        </span>
                        <span className="asset-metric-separator">·</span>
                        <span className={`asset-metric-rate ${intervalClass}`}>
                          {formatPct(intervalChangePct)}
                          <span className="asset-metric-rate-suffix">{intervalPctSuffix}</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>
                  );
                })()}
              </div>
            ))}
            {allocationChartData.length > 0 && (
              <div className="asset-allocation-donut-cell">
                <div className="asset-allocation-donut" aria-label="Asset allocation weightage pie chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={allocationChartData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="60%"
                        outerRadius="100%"
                        paddingAngle={0}
                        stroke="#fff"
                        strokeWidth={1}
                        isAnimationActive={false}
                      >
                        {allocationChartData.map((datum) => (
                          <Cell key={datum.type} fill={ASSET_TYPE_COLORS[datum.type] || '#6c757d'} />
                        ))}
                      </Pie>
                      <RechartsTooltip content={<AllocationChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="asset-allocation-donut-caption">Weight by value</div>
                <div className="asset-allocation-legend">
                  {allocationChartData.map((datum) => (
                    <span className="asset-allocation-legend-item" key={datum.type}>
                      <span
                        className="asset-allocation-legend-dot"
                        style={{ backgroundColor: ASSET_TYPE_COLORS[datum.type] || '#6c757d' }}
                      />
                      <span className="asset-allocation-legend-label">{datum.name}</span>
                      <span className="asset-allocation-legend-pct">{Number(datum.pct || 0).toFixed(1)}%</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card.Body>
      </Card>

      <DashboardRolloverTable
        title="Portfolio Change History"
        showSource={false}
        compactCollapsed={true}
      />

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
