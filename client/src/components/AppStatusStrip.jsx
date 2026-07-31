import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';
import { getDashboardVersion, getDailyValuesHealthStatus } from '../services/api';
import { formatDate } from '../utils/formatters';
import { resolvePortfolioColor } from '../utils/portfolioColors';

function combineIndicatorHealth(results) {
  const availableResults = results.filter(Boolean);
  if (!availableResults.length) return null;

  const counts = availableResults.reduce((combined, result) => ({
    missing_rows: combined.missing_rows + Number(result.counts?.missing_rows || 0),
    compliance_errors: combined.compliance_errors + Number(result.counts?.compliance_errors || 0),
    unexpected_locf: combined.unexpected_locf + Number(result.counts?.unexpected_locf || 0),
    stale_scopes: combined.stale_scopes + Number(result.counts?.stale_scopes || 0),
    pending_dirty_scopes: combined.pending_dirty_scopes + Number(result.counts?.pending_dirty_scopes || 0),
    prewarn_scopes: combined.prewarn_scopes + Number(result.counts?.prewarn_scopes || 0),
  }), {
    missing_rows: 0,
    compliance_errors: 0,
    unexpected_locf: 0,
    stale_scopes: 0,
    pending_dirty_scopes: 0,
    prewarn_scopes: 0,
  });

  const status = counts.missing_rows > 0 || counts.compliance_errors > 0
    ? 'error'
    : (counts.unexpected_locf > 0 || counts.stale_scopes > 0 || counts.pending_dirty_scopes > 0 ? 'warning' : 'ok');

  return { status, counts };
}

export default function AppStatusStrip() {
  const { pathname } = useLocation();
  const { selectedId, selectedIds, selectedPortfolio, selectedPortfolios, portfolios } = usePortfolio();
  const [lastUpdate, setLastUpdate] = useState(null);
  const [dailyHealth, setDailyHealth] = useState(null);
  const selectedIdsKey = (selectedIds || []).join(',');

  useEffect(() => {
    let active = true;

    async function loadStatus() {
      const [version, healthResults] = await Promise.all([
        getDashboardVersion().catch(() => null),
        selectedIds.length > 1
          ? Promise.all(selectedIds.map((id) => getDailyValuesHealthStatus(id).catch(() => null)))
          : getDailyValuesHealthStatus(selectedId).then((result) => [result]).catch(() => []),
      ]);

      if (!active) return;
      setLastUpdate(version?.lastUpdate || null);
      setDailyHealth(combineIndicatorHealth(healthResults));
    }

    loadStatus();
    return () => {
      active = false;
    };
  }, [pathname, selectedId, selectedIdsKey]);

  const headerPortfolios = selectedPortfolios?.length ? selectedPortfolios : (portfolios || []);
  const visiblePortfolios = headerPortfolios.slice(0, 4);
  const overflowCount = Math.max(0, headerPortfolios.length - visiblePortfolios.length);
  const portfolioLabel = selectedPortfolio
    ? 'Selected portfolio'
    : (selectedIds.length > 1 ? 'Selected portfolios' : 'Portfolio selection');
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
    <div className="dashboard-header app-status-strip mb-4">
      <div className="dashboard-title-row dashboard-portfolio-strip" aria-label={portfolioLabel}>
        {visiblePortfolios.map((portfolio) => (
          <span
            key={portfolio.id}
            className="portfolio-dot dashboard-portfolio-dot"
            style={{ backgroundColor: resolvePortfolioColor(portfolio) }}
            title={portfolio.name}
            aria-label={portfolio.name}
          />
        ))}
        {overflowCount > 0 && (
          <span className="dashboard-portfolio-overflow" title={`${overflowCount} more portfolios`}>
            +{overflowCount}
          </span>
        )}
      </div>
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
  );
}