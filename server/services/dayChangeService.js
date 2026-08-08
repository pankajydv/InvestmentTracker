const { getMarketSessionDates } = require('./marketPriceCache');
const { DAY_CHANGE_FALLBACK_MAX_LAG_SESSIONS } = require('./freshnessPolicy');

const MARKET_LINKED_ASSET_TYPES = new Set([
  'INDIAN_STOCK',
  'FOREIGN_STOCK',
  'SGB',
  'MUTUAL_FUND',
  'NPS',
]);

function sourceName(row) {
  return String(row?.price_source || row?.source || '').trim().toUpperCase();
}

function isNonLocfSource(row) {
  if (!row) return false;
  if (row.has_non_locf != null) return Number(row.has_non_locf) > 0;
  return sourceName(row) !== 'LOCF';
}

function sessionDistance(candidateDate, targetDate, assetType) {
  if (!candidateDate || !targetDate || candidateDate > targetDate) {
    return Number.POSITIVE_INFINITY;
  }

  const start = new Date(`${candidateDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) return Number.POSITIVE_INFINITY;
  start.setUTCDate(start.getUTCDate() + 1);
  const strictStart = start.toISOString().slice(0, 10);
  if (strictStart > targetDate) return 0;

  const sessions = getMarketSessionDates(strictStart, targetDate, assetType);
  return Array.isArray(sessions) ? sessions.length : Number.POSITIVE_INFINITY;
}

function emptyMetric({ usedFallback = false, staleFallback = false } = {}) {
  return {
    change: 0,
    changePct: 0,
    openingValue: 0,
    currentValue: 0,
    asOfDate: null,
    source: null,
    sourceMixed: false,
    usedFallback,
    staleFallback,
  };
}

function metricFromRow(row, usedFallback) {
  const change = Number(row?.day_change || 0);
  const currentValue = Number(row?.current_value || 0);
  const openingValue = Math.max(currentValue - change, 0);
  return {
    change,
    changePct: openingValue > 0 ? (change / openingValue) * 100 : 0,
    openingValue,
    currentValue,
    asOfDate: row?.date || null,
    source: sourceName(row) || null,
    sourceMixed: false,
    usedFallback,
    staleFallback: false,
  };
}

function resolveMetric(rows, startIndex, assetType) {
  const anchor = rows[startIndex];
  if (!anchor) return { metric: emptyMetric(), rowIndex: -1 };

  const normalizedType = String(assetType || '').toUpperCase();
  const marketLinked = MARKET_LINKED_ASSET_TYPES.has(normalizedType);

  if (!marketLinked || isNonLocfSource(anchor)) {
    return { metric: metricFromRow(anchor, false), rowIndex: startIndex };
  }

  for (let index = startIndex + 1; index < rows.length; index += 1) {
    const candidate = rows[index];
    if (!isNonLocfSource(candidate)) continue;
    if (sessionDistance(candidate.date, anchor.date, normalizedType) <= DAY_CHANGE_FALLBACK_MAX_LAG_SESSIONS) {
      return { metric: metricFromRow(candidate, true), rowIndex: index };
    }
    break;
  }

  return {
    metric: emptyMetric({ usedFallback: true, staleFallback: true }),
    rowIndex: -1,
  };
}

function resolveDayChangePair(rowsDesc, assetType) {
  const rows = Array.isArray(rowsDesc) ? rowsDesc : [];
  const oneDay = resolveMetric(rows, 0, assetType);
  const yesterdayStart = oneDay.rowIndex >= 0 ? oneDay.rowIndex + 1 : rows.length;
  const yesterday = resolveMetric(rows, yesterdayStart, assetType);

  return {
    oneDay: oneDay.metric,
    yesterday: yesterday.metric,
  };
}

function aggregateDayChangeMetrics(metrics) {
  const values = (metrics || []).filter(Boolean);
  if (!values.length) return emptyMetric();

  const change = values.reduce((sum, metric) => sum + Number(metric.change || 0), 0);
  const openingValue = values.reduce((sum, metric) => sum + Number(metric.openingValue || 0), 0);
  const currentValue = values.reduce((sum, metric) => sum + Number(metric.currentValue || 0), 0);
  const dates = new Set(values.map((metric) => metric.asOfDate).filter(Boolean));
  const sources = new Set(values.map((metric) => metric.source).filter(Boolean));

  return {
    change,
    changePct: openingValue > 0 ? (change / openingValue) * 100 : 0,
    openingValue,
    currentValue,
    asOfDate: dates.size === 1 ? [...dates][0] : null,
    asOfDateMixed: dates.size > 1,
    source: sources.size === 1 ? [...sources][0] : (sources.size > 1 ? 'MIXED' : null),
    sourceMixed: sources.size > 1,
    usedFallback: values.some((metric) => metric.usedFallback),
    staleFallback: values.some((metric) => metric.staleFallback),
  };
}

function aggregateDayChangePairs(pairs) {
  return {
    oneDay: aggregateDayChangeMetrics((pairs || []).map((pair) => pair?.oneDay)),
    yesterday: aggregateDayChangeMetrics((pairs || []).map((pair) => pair?.yesterday)),
  };
}

module.exports = {
  resolveDayChangePair,
  aggregateDayChangePairs,
};