const https = require('https');
const {
  fetchDividendEventsForRange,
  fetchHistoricalOHLC,
  fetchHistoricalUSDToINR,
  fetchHistoricalUSDToINRRange,
  fetchMutualFundHistory,
  fetchMutualFundNAV,
  fetchStockPrice,
  fetchNPSNAV,
  fetchSGBLivePrice,
  resolvePriceSourceFromProviderDate,
} = require('./priceService');
const { fetchNPSHistory } = require('./priceService');
const {
  calculatePfInterestPreview,
  calculatePfValueAsOfDate,
  calculateSmallSavingsInterestPreview,
  calculateSmallSavingsValueAsOfDate,
} = require('./pfInterestCalculator');
const { computeBondAccruedCoupon } = require('./bondAccrualService');
const {
  getSeries,
  upsertInvestmentPriceSeries,
  getInvestmentSeries,
  getInvestmentNearestOnOrBefore,
  hydrateHistoricalPriceSeries,
  hydrateStockSeriesForPhase2,
  getMarketSessionDates,
  getNearestOnOrBefore,
  getLocfCoverableSessionDates,
} = require('./marketPriceCache');
const { updateAggregateDailyRange } = require('./updater');
const { setBackfillProgress } = require('./dirtyBackfillService');
const { safeRebuildCanonicalProjections } = require('./canonicalProjectionEngine');
const { generateVestSuggestions } = require('./rsuVestActualizationService');
const { toIsoDate, todayIso, exchangeDateFromUnixSeconds } = require('./dateUtils');
const { logBackfillInfo, logBackfillWarn, logBackfillError } = require('./appLogger');
const { LOCF_STREAK_WARN_SESSIONS } = require('./freshnessPolicy');
const { getMarketHolidays, getWeekends } = require('./holidays/marketHolidayService');
const {
  INVESTED_AMOUNT_INFLOW_TYPES,
  REALIZED_CASHFLOW_TYPES,
  REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL,
} = require('../constants/transactionTypes');
const { EXTERNAL_CASH_IN_TYPES, EXTERNAL_CASH_OUT_TYPES } = require('./transactionEffectPolicy');
const {
  quantizeForStorage,
  quantizeNullableForStorage,
} = require('./numberPrecision');

function clampEndDateToToday(endDate) {
  const end = toIsoDate(endDate) || todayIso();
  const today = todayIso();
  return end > today ? today : end;
}

function eachDate(fromDate, toDate) {
  const out = [];
  let d = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (d <= end) {
    out.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function addDays(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().split('T')[0];
}

function getMarketCacheEvaluationEndDate(runDate) {
  const normalizedRunDate = toIsoDate(runDate) || todayIso();
  const today = todayIso();
  return normalizedRunDate < today ? normalizedRunDate : today;
}

function getMarketClosedSetForYear(year, db, cache) {
  if (!cache.closedMarketDaysByYear) cache.closedMarketDaysByYear = new Map();
  if (cache.closedMarketDaysByYear.has(year)) return cache.closedMarketDaysByYear.get(year);
  const holidays = getMarketHolidays(year, db).map((h) => h.date);
  const weekends = getWeekends(year).map((w) => w.date);
  const set = new Set([...holidays, ...weekends]);
  cache.closedMarketDaysByYear.set(year, set);
  return set;
}

function isMarketSessionDate(dateIso, db, cache, assetType = null) {
  if (!dateIso) return false;
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  if (String(assetType || '') === 'FOREIGN_STOCK') {
    // Foreign-stock sessions should not be filtered by India holiday calendar.
    return true;
  }
  const year = d.getUTCFullYear();
  const closed = getMarketClosedSetForYear(year, db, cache);
  return !closed.has(dateIso);
}

const STOCK_CACHE_WARN_INDIAN_SETTLEMENT_CUTOFF_MINUTES_IST = 17 * 60 + 45;

function inferStockInstrumentType(symbol) {
  return /\.(NS|BO)$/i.test(String(symbol || '')) ? 'INDIAN_STOCK' : 'FOREIGN_STOCK';
}

function getIstClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const val = (type) => parts.find((p) => p.type === type)?.value || '';
  return {
    date: `${val('year')}-${val('month')}-${val('day')}`,
    minutes: Number(val('hour')) * 60 + Number(val('minute')),
  };
}

function normalizeStockSymbol(symbol, assetType) {
  const raw = String(symbol || '').trim();
  if (!raw) return null;
  if (String(assetType || '') === 'INDIAN_STOCK' && !raw.includes('.')) {
    return `${raw}.NS`;
  }
  return raw;
}

function normalizeMutualFundCode(code) {
  const raw = String(code || '').trim();
  return raw || null;
}

function loadSymbolHistoryByInvestment(db, investmentIds = []) {
  const ids = Array.from(new Set((investmentIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map();
  if (!ids.length) return map;

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT investment_id, symbol, date(valid_from) AS valid_from, date(valid_to) AS valid_to
    FROM investment_symbol_history
    WHERE investment_id IN (${placeholders})
    ORDER BY investment_id ASC, valid_from ASC, id ASC
  `).all(...ids);

  for (const row of rows) {
    const investmentId = Number(row.investment_id);
    const list = map.get(investmentId) || [];
    list.push({
      symbol: String(row.symbol || '').trim(),
      validFrom: String(row.valid_from || ''),
      validTo: row.valid_to ? String(row.valid_to) : null,
    });
    map.set(investmentId, list);
  }

  return map;
}

function resolveStockSymbolForDate(inv, date, cache) {
  const currentTicker = normalizeStockSymbol(inv?.ticker_symbol, inv?.asset_type);
  const historyRows = cache?.symbolHistoryByInvestment?.get(inv?.id) || [];
  for (const row of historyRows) {
    if (!row?.symbol || !row?.validFrom) continue;
    if (date < row.validFrom) continue;
    if (row.validTo && date > row.validTo) continue;
    return normalizeStockSymbol(row.symbol, inv?.asset_type) || currentTicker;
  }
  return currentTicker;
}

function resolveMutualFundCodeForDate(inv, date, cache) {
  const currentCode = normalizeMutualFundCode(inv?.amfi_code);
  const historyRows = cache?.symbolHistoryByInvestment?.get(inv?.id) || [];
  for (const row of historyRows) {
    if (!row?.symbol || !row?.validFrom) continue;
    if (date < row.validFrom) continue;
    if (row.validTo && date > row.validTo) continue;
    return normalizeMutualFundCode(row.symbol) || currentCode;
  }
  return currentCode;
}

function getInvestmentStockSymbols(inv, cache) {
  const symbols = new Set();
  const currentTicker = normalizeStockSymbol(inv?.ticker_symbol, inv?.asset_type);
  if (currentTicker) symbols.add(currentTicker);

  const historyRows = cache?.symbolHistoryByInvestment?.get(inv?.id) || [];
  for (const row of historyRows) {
    const normalized = normalizeStockSymbol(row?.symbol, inv?.asset_type);
    if (normalized) symbols.add(normalized);
  }

  return Array.from(symbols);
}

function getSymbolHistoryRows(inv, cache) {
  return cache?.symbolHistoryByInvestment?.get(inv?.id) || [];
}

function getSymbolEffectiveStartDate(inv, symbol, baseStartDate, cache, runDate) {
  const normalizedSymbol = normalizeStockSymbol(symbol, inv?.asset_type);
  if (!normalizedSymbol) return baseStartDate;

  const rows = getSymbolHistoryRows(inv, cache)
    .map((r) => ({
      symbol: normalizeStockSymbol(r?.symbol, inv?.asset_type),
      validFrom: r?.validFrom || null,
      validTo: r?.validTo || null,
    }))
    .filter((r) => !!r.symbol && !!r.validFrom)
    .sort((a, b) => String(a.validFrom).localeCompare(String(b.validFrom)));

  // Historical rows explicitly declaring this symbol.
  const matching = rows.filter((r) => r.symbol === normalizedSymbol);
  if (matching.length) {
    // For backfill coverage checks, evaluate from the holding window start.
    // This keeps sparse-coverage warnings aligned to transaction scope even when
    // symbol-history metadata starts later than the first transaction date.
    return baseStartDate;
  }

  // If this is the current ticker and history exists, assume it starts after the latest closed window.
  const currentTicker = normalizeStockSymbol(inv?.ticker_symbol, inv?.asset_type);
  if (rows.length && currentTicker === normalizedSymbol) {
    const closedRows = rows.filter((r) => !!r.validTo);
    if (closedRows.length) {
      const latestClosed = closedRows
        .map((r) => r.validTo)
        .sort()
        .pop();
      if (latestClosed) {
        const inferredStart = addDays(latestClosed, 1);
        if (inferredStart <= runDate && inferredStart > baseStartDate) {
          return inferredStart;
        }
      }
    }
  }

  return baseStartDate;
}

function getMissingMarketSessionSegments(seriesRows, marketSessionDates) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return [];
  const coveredDates = new Set(
    (seriesRows || [])
      .filter((row) => row?.date && row?.close != null)
      .map((row) => row.date)
  );

  const segments = [];
  let activeSegment = null;
  for (const date of marketSessionDates) {
    if (coveredDates.has(date)) {
      activeSegment = null;
      continue;
    }

    if (!activeSegment) {
      activeSegment = [];
      segments.push(activeSegment);
    }
    activeSegment.push(date);
  }

  return segments;
}

function hasCompleteInvestmentCoverage(seriesRows, marketSessionDates) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return true;
  const coveredDates = new Set(
    (seriesRows || [])
      .filter((row) => row?.date && row?.close != null)
      .map((row) => row.date)
  );

  for (const date of marketSessionDates) {
    if (!coveredDates.has(date)) return false;
  }
  return true;
}

function getMissingSessionSegmentsFromSeries(marketSessionDates, seriesMap) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return [];
  const series = seriesMap instanceof Map ? seriesMap : new Map();

  const segments = [];
  let active = null;
  for (const date of marketSessionDates) {
    if (series.has(date)) {
      active = null;
      continue;
    }
    if (!active) {
      active = [];
      segments.push(active);
    }
    active.push(date);
  }
  return segments;
}

function getMaxContiguousMissingCount(marketSessionDates, seriesMap) {
  const segments = getMissingSessionSegmentsFromSeries(marketSessionDates, seriesMap);
  if (!segments.length) return 0;
  return segments.reduce((maxGap, segment) => Math.max(maxGap, segment.length), 0);
}

function buildMissingSymbolWindows(inv, missingSegments, cache) {
  if (!inv || !Array.isArray(missingSegments) || missingSegments.length === 0) return [];

  const windows = [];
  for (const segment of missingSegments) {
    if (!Array.isArray(segment) || segment.length === 0) continue;

    let activeWindow = null;
    for (const date of segment) {
      const symbol = resolveStockSymbolForDate(inv, date, cache);
      if (!symbol) {
        activeWindow = null;
        continue;
      }

      if (!activeWindow || activeWindow.symbol !== symbol) {
        activeWindow = {
          symbol,
          startDate: date,
          endDate: date,
        };
        windows.push(activeWindow);
        continue;
      }

      activeWindow.endDate = date;
    }
  }

  return windows;
}

function buildMissingMutualFundWindows(inv, missingSegments, cache) {
  if (!inv || !Array.isArray(missingSegments) || missingSegments.length === 0) return [];

  const windows = [];
  for (const segment of missingSegments) {
    if (!Array.isArray(segment) || segment.length === 0) continue;

    let activeWindow = null;
    for (const date of segment) {
      const code = resolveMutualFundCodeForDate(inv, date, cache);
      if (!code) {
        activeWindow = null;
        continue;
      }

      if (!activeWindow || activeWindow.code !== code) {
        activeWindow = {
          code,
          startDate: date,
          endDate: date,
        };
        windows.push(activeWindow);
        continue;
      }

      activeWindow.endDate = date;
    }
  }

  return windows;
}

function buildMissingNpsWindows(inv, missingSegments) {
  if (!inv || !Array.isArray(missingSegments) || missingSegments.length === 0) return [];

  const code = String(inv.nps_fund_code || '').trim();
  if (!code) return [];

  const windows = [];
  for (const segment of missingSegments) {
    if (!Array.isArray(segment) || segment.length === 0) continue;
    windows.push({
      code,
      startDate: segment[0],
      endDate: segment[segment.length - 1],
    });
  }

  return windows;
}

const AGGREGATE_RESUME_KEY = 'backfill_aggregate_resume_v1';
const ENABLE_ROW_WRITE_AUDIT = String(process.env.APP_ROW_WRITE_AUDIT_LOG || 'true').toLowerCase() === 'true';

function logBackfillStep(step, substep, stepName, phase, meta = {}) {
  const normalizedStep = Number.isFinite(Number(step)) ? String(step) : String(step || 'NA');
  const normalizedSubstep = substep == null ? null : String(substep);
  const tag = normalizedSubstep ? `Step-${normalizedStep}.${normalizedSubstep}` : `Step-${normalizedStep}`;
  const phaseLabel = String(phase || 'running').toUpperCase();
  logBackfillInfo(`[Backfill][${tag}] ${stepName} [${phaseLabel}]`, {
    step: normalizedStep,
    substep: normalizedSubstep,
    stepName,
    phase,
    ...meta,
  });
}

function readAggregateResumeState(db) {
  const row = db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1').get(AGGREGATE_RESUME_KEY);
  if (!row?.value) return null;

  try {
    const parsed = JSON.parse(String(row.value));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!toIsoDate(parsed.runDate) || !toIsoDate(parsed.rangeStart) || !toIsoDate(parsed.rangeEnd)) return null;
    if (parsed.nextDate != null && !toIsoDate(parsed.nextDate)) return null;
    return {
      runDate: toIsoDate(parsed.runDate),
      rangeStart: toIsoDate(parsed.rangeStart),
      rangeEnd: toIsoDate(parsed.rangeEnd),
      nextDate: parsed.nextDate ? toIsoDate(parsed.nextDate) : null,
    };
  } catch (_) {
    logBackfillError('[Backfill][Resume] Failed to parse aggregate resume state config payload');
    return null;
  }
}

function writeAggregateResumeState(db, payload) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(AGGREGATE_RESUME_KEY, JSON.stringify(payload));
}

function clearAggregateResumeState(db) {
  db.prepare('DELETE FROM config WHERE key = ?').run(AGGREGATE_RESUME_KEY);
}

function progressLogStride(total, maxSteps = 10) {
  const t = Number(total || 0);
  if (t <= 0) return 1;
  return Math.max(1, Math.ceil(t / Math.max(1, maxSteps)));
}

function shouldHeartbeat(lastAtMs, intervalMs = 60_000) {
  return (Date.now() - Number(lastAtMs || 0)) >= intervalMs;
}

function normalizeMfDate(dateValue) {
  const value = String(dateValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function mergeDelimitedValues(existingValue, nextValue, delimiter = ' | ') {
  const parts = [];
  const seen = new Set();

  const add = (value) => {
    if (!value) return;
    const tokens = String(value)
      .split(delimiter)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      parts.push(token);
    }
  };

  add(existingValue);
  add(nextValue);
  return parts.length ? parts.join(delimiter) : null;
}

function classifyHistoricalReplayIntent(reason, sourceEventId) {
  const haystack = `${String(reason || '')} ${String(sourceEventId || '')}`.toLowerCase();

  if (
    haystack.includes('manual-backfill')
    || haystack.includes('manual-rebuild')
    || haystack.includes('latest-code')
    || haystack.includes('full-backfill')
  ) {
    return 'manual-historical-rebuild';
  }
  if (haystack.includes('scheduler-downtime-catchup') || haystack.includes('scheduler-catchup')) {
    return 'scheduler-catchup';
  }
  if (haystack.includes('gap repair') || haystack.includes('gap_repair') || haystack.includes('compliance')) {
    return 'automatic-repair';
  }
  if (haystack.includes('symbol_history')) {
    return 'symbol-history';
  }
  if (haystack.includes('transaction-') || haystack.includes('corporate-action')) {
    return 'transaction-or-ca';
  }
  return 'unspecified';
}

function isValidNpsNav(nav) {
  const n = Number(nav);
  if (!Number.isFinite(n) || n <= 0) return false;
  // Guard against placeholder/test NAV pollution.
  if (Math.abs(n - 99.99) < 1e-6) return false;
  return true;
}

function nearestOnOrBefore(seriesMap, date) {
  if (!seriesMap || !seriesMap.size) return null;
  let bestDate = null;
  let bestValue = null;
  for (const [d, v] of seriesMap.entries()) {
    if (d <= date && (bestDate == null || d > bestDate)) {
      bestDate = d;
      bestValue = v;
    }
  }
  return bestValue;
}

function warnBackfillOnce(cache, key, message, meta = null) {
  if (!cache || !cache.warnedFallbacks) {
    logBackfillWarn(message, meta);
    return;
  }
  if (cache.warnedFallbacks.has(key)) return;
  cache.warnedFallbacks.add(key);
  logBackfillWarn(message, meta);
}

function isPhase3LocalOnly(cache) {
  return cache?.phase === 'phase3_local_only';
}

function canUseProviderForRunDate(cache, date) {
  const runDate = toIsoDate(cache?.runDate);
  if (!runDate || runDate !== todayIso()) return false;
  return toIsoDate(date) === runDate;
}

function isPhase3ProviderBlocked(cache, date) {
  return isPhase3LocalOnly(cache) && !canUseProviderForRunDate(cache, date);
}

function warnPhase3ProviderViolation(cache, key, message, meta = null) {
  warnBackfillOnce(cache, `phase3-provider:${key}`, message, {
    ...(meta || {}),
    phase: cache?.phase || null,
  });
}

function loadSeriesMapFromLocalCache(instrumentType, symbol, fromDate, toDate, valuePicker = (row) => row.close) {
  const rows = getSeries(instrumentType, symbol, fromDate, toDate).filter((row) => row?.date);
  const map = new Map();
  for (const row of rows) {
    const value = valuePicker(row);
    if (value == null) continue;
    map.set(row.date, Number(value));
  }
  return map;
}

function loadInvestmentSeriesMapFromLocalCache(investmentId, fromDate, toDate, valuePicker = (row) => row.close) {
  const rows = getInvestmentSeries(investmentId, fromDate, toDate).filter((row) => row?.date);
  const map = new Map();
  for (const row of rows) {
    const value = valuePicker(row);
    if (value == null) continue;
    map.set(row.date, Number(value));
  }
  return map;
}

function getLocalFxRateOnOrBefore(date) {
  const row = getNearestOnOrBefore('FX', 'USDINR=X', date);
  if (row?.close == null) return null;
  return Number(row.close);
}

// Must remain within investment_metrics_daily.price_source CHECK constraint.
const IPO_CACHE_FILL_MAX_SESSIONS = 20;
const IPO_CACHE_FILL_SOURCE = 'IPO';
const STOCK_PROVIDER_PUBLISH_CUTOFF_MINUTES = 9 * 60 + 30;
const EXITED_UNITS_EPSILON = 1e-6;

function backfillPreProviderIpoSessions({
  investmentId,
  instrumentType,
  symbol,
  fillStartDate,
  fillEndDate,
  seriesMap,
}) {
  if (!investmentId || !instrumentType || !fillStartDate || !fillEndDate || fillStartDate > fillEndDate) {
    return null;
  }

  const sessions = getMarketSessionDates(fillStartDate, fillEndDate, instrumentType);
  if (!sessions.length) return null;

  const series = seriesMap instanceof Map ? seriesMap : new Map();
  const firstProviderDate = sessions.find((d) => series.has(d));
  if (!firstProviderDate || firstProviderDate <= fillStartDate) return null;

  const preProviderSessionDates = sessions.filter((d) => d < firstProviderDate);
  if (!preProviderSessionDates.length || preProviderSessionDates.length > IPO_CACHE_FILL_MAX_SESSIONS) {
    return null;
  }

  const providerClose = Number(series.get(firstProviderDate));
  if (!Number.isFinite(providerClose) || providerClose <= 0) return null;

  const missingDates = preProviderSessionDates.filter((d) => !series.has(d));
  if (!missingDates.length) return null;

  const ipoPoints = missingDates.map((d) => ({
    date: d,
    open: providerClose,
    high: providerClose,
    low: providerClose,
    close: providerClose,
    adjClose: providerClose,
    volume: null,
    source: IPO_CACHE_FILL_SOURCE,
  }));

  upsertInvestmentPriceSeries(investmentId, instrumentType, symbol || null, ipoPoints, IPO_CACHE_FILL_SOURCE);
  for (const d of missingDates) series.set(d, providerClose);

  return {
    firstProviderDate,
    ipoFilledSessions: missingDates.length,
  };
}

function getProviderReadyEndDate(runDate, db) {
  return getMarketCacheEvaluationEndDate(runDate);
}

function fetchStockSeriesFromSource(symbol, startDate, endDate) {
  const from = new Date(`${startDate}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(`${endDate}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) {
            resolve([]);
            return;
          }
          const timestamps = result.timestamp || [];
          const meta = result.meta || {};
          const exchangeTz = String(meta.exchangeTimezoneName || '').trim();
          const nowSec = Math.floor(Date.now() / 1000);
          const regularEnd = Number(meta.currentTradingPeriod?.regular?.end);
          const currentSessionStart = Number(meta.currentTradingPeriod?.regular?.start);
          const currentSessionDate = Number.isFinite(currentSessionStart)
            ? exchangeDateFromUnixSeconds(currentSessionStart, exchangeTz)
            : null;
          // The current session's candle is still forming until its regular close passes.
          // Never persist an unsettled candle as a settled close.
          const currentSessionUnsettled = Number.isFinite(regularEnd) && nowSec < regularEnd;
          const quote = result.indicators?.quote?.[0] || {};
          const opens = quote.open || [];
          const highs = quote.high || [];
          const lows = quote.low || [];
          const closes = quote.close || [];
          const volumes = quote.volume || [];
          const rows = [];
          for (let i = 0; i < timestamps.length; i += 1) {
            const close = closes[i];
            if (close == null) continue;
            // Attribute dates in the exchange's local timezone (never IST/UTC).
            const d = exchangeDateFromUnixSeconds(timestamps[i], exchangeTz);
            if (!d) continue;
            // Skip the current, not-yet-settled session so partial intraday values
            // are never written into the cache.
            if (currentSessionUnsettled && currentSessionDate && d >= currentSessionDate) continue;
            const closeNum = Number(close);
            if (!Number.isFinite(closeNum) || closeNum <= 0) continue;

            const openNumRaw = Number(opens[i]);
            const highNumRaw = Number(highs[i]);
            const lowNumRaw = Number(lows[i]);
            const volumeRaw = Number(volumes[i]);

            const openNum = Number.isFinite(openNumRaw) && openNumRaw > 0 ? openNumRaw : closeNum;
            const highNum = Number.isFinite(highNumRaw) && highNumRaw > 0 ? highNumRaw : Math.max(openNum, closeNum);
            const lowNum = Number.isFinite(lowNumRaw) && lowNumRaw > 0 ? lowNumRaw : Math.min(openNum, closeNum);
            const volumeNum = Number.isFinite(volumeRaw) && volumeRaw >= 0 ? Math.round(volumeRaw) : 0;

            rows.push({
              date: d,
              open: openNum,
              high: highNum,
              low: lowNum,
              close: closeNum,
              volume: volumeNum,
              source: 'YAHOO',
            });
          }
          resolve(rows);
        } catch (e) {
          reject(new Error(`Failed to parse stock series for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchStockSeries(symbol, startDate, endDate, options = {}) {
  if (!startDate || !endDate || startDate > endDate) {
    return new Map();
  }

  const instrumentType = inferStockInstrumentType(symbol);
  const rows = await hydrateStockSeriesForPhase2({
    investmentId: options.investmentId || null,
    instrumentType,
    symbol,
    fromDate: startDate,
    toDate: endDate,
    sourceLabel: 'YAHOO',
    fetchRange: async (missingFrom, missingTo) => fetchStockSeriesFromSource(symbol, missingFrom, missingTo),
    mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
    onWarn: (message, meta) => logBackfillWarn(message, meta),
    onInfo: (message, meta) => logBackfillInfo(message, meta),
  }).catch((err) => {
    logBackfillError(`[Backfill][StockCache] Hydration failed for ${symbol}: ${err?.message || err}`);
    return [];
  });

  const series = new Map();
  for (const row of rows) {
    if (!row?.date) continue;
    const effectiveClose = row.adj_close ?? row.adjClose ?? row.close;
    if (effectiveClose != null) series.set(row.date, Number(effectiveClose));
  }

  const marketSessionDates = getMarketSessionDates(startDate, endDate, instrumentType);
  const firstCachedSessionDate = marketSessionDates.find((d) => series.has(d));
  const locfCoverableDates = getLocfCoverableSessionDates(rows, marketSessionDates, instrumentType, options.locfCutoffDate || null);
  const missingSessionDates = marketSessionDates.filter((d) => !series.has(d) && !locfCoverableDates.has(d));
  const firstMissingDate = missingSessionDates[0] || null;

  let shouldWarnSparseCoverage = !!firstMissingDate;
  let warningSuppressedReason = null;

  if (shouldWarnSparseCoverage && instrumentType === 'FOREIGN_STOCK') {
    const ist = getIstClock();
    const foreignEdgeDates = new Set([ist.date, addDays(ist.date, -1)]);
    const hasOnlyEdgeMissing = missingSessionDates.every((d) => foreignEdgeDates.has(d));
    if (hasOnlyEdgeMissing) {
      shouldWarnSparseCoverage = false;
      warningSuppressedReason = missingSessionDates.includes(ist.date)
        ? 'FOREIGN_SAME_DAY_PENDING'
        : 'FOREIGN_PREVIOUS_DAY_PENDING';
    }
  }

  if (shouldWarnSparseCoverage && instrumentType === 'INDIAN_STOCK' && firstMissingDate === endDate) {
    const ist = getIstClock();
    if (endDate === ist.date && ist.minutes < STOCK_CACHE_WARN_INDIAN_SETTLEMENT_CUTOFF_MINUTES_IST) {
      shouldWarnSparseCoverage = false;
      warningSuppressedReason = 'INDIAN_SAME_DAY_PENDING';
    }
  }

  const warningRunDate = toIsoDate(options?.runDate) || todayIso();
  if (shouldWarnSparseCoverage && firstMissingDate >= warningRunDate) {
    shouldWarnSparseCoverage = false;
    warningSuppressedReason = 'SAME_DAY_CACHE_PENDING';
  }

  if (shouldWarnSparseCoverage && options?.suppressSparseWarning !== true) {
    logBackfillWarn(`[Backfill][StockCache] Coverage still sparse after hydration for ${symbol}`, {
      symbol,
      startDate,
      endDate,
      cachedPoints: series.size,
      expectedSessions: marketSessionDates.length,
      firstCachedSessionDate: firstCachedSessionDate || null,
      firstMissingDate,
      missingSessionCount: missingSessionDates.length,
    });
  } else if (warningSuppressedReason && options?.suppressSparseWarning !== true) {
    logBackfillInfo(`[Backfill][StockCache] Sparse coverage warning suppressed for ${symbol}`, {
      symbol,
      startDate,
      endDate,
      firstMissingDate,
      missingSessionCount: missingSessionDates.length,
      reason: warningSuppressedReason,
    });
  }

  return series;
}

function getStoredPriceOnOrBefore(db, investmentId, portfolioId, date) {
  if (portfolioId == null) return null;
  const row = db.prepare(
    'SELECT date, price_per_unit FROM investment_metrics_daily WHERE investment_id = ? AND portfolio_id = ? AND date <= ? ORDER BY date DESC LIMIT 1'
  ).get(investmentId, portfolioId, date);
  return row ? { price: Number(row.price_per_unit || 0), source: row.date === date ? 'LIVE' : 'LOCF' } : null;
}

async function getPriceForDate(db, inv, date, cache, portfolioId) {
  if (inv.asset_type === 'BOND') {
    return { price: Number(inv.face_value || 1000), source: 'COMPUTED', origin: 'local_compute_face_value' };
  }

  if (inv.asset_type === 'MUTUAL_FUND') {
    const currentCode = normalizeMutualFundCode(inv.amfi_code);
    if (!currentCode) return { price: 0, source: 'COMPUTED', origin: 'local_compute_missing_code' };
    if (!cache.mfByInvestment) cache.mfByInvestment = new Map();
    if (!cache.mfByInvestment.has(inv.id)) {
      const map = loadInvestmentSeriesMapFromLocalCache(
        inv.id,
        cache.rangeStart || '1900-01-01',
        cache.rangeEnd || date,
        (row) => row.close
      );
      cache.mfByInvestment.set(inv.id, map);
      if (isPhase3ProviderBlocked(cache, date)) {
        warnPhase3ProviderViolation(
          cache,
          `mf-history:inv-${inv.id}`,
          `[Backfill][Phase-3] Provider fetch blocked for MUTUAL_FUND ${currentCode}; using local cache only`,
          { investmentId: inv.id, portfolioId, date }
        );
      }
    }
    const map = cache.mfByInvestment.get(inv.id) || new Map();
    const exact = map.get(date);
    if (exact != null) return { price: Number(exact), source: 'LIVE', origin: 'market_cache_exact' };

    if (canUseProviderForRunDate(cache, date)) {
      try {
        const navCode = resolveMutualFundCodeForDate(inv, date, cache) || currentCode;
        const navData = await fetchMutualFundNAV(navCode);
        const nav = Number(navData?.nav || 0);
        if (Number.isFinite(nav) && nav > 0) {
          const navDate = normalizeMfDate(navData?.date);
          return {
            price: nav,
            source: navDate === date ? 'LIVE' : 'LOCF',
            origin: navDate === date ? 'provider' : 'provider_lag',
          };
        }
      } catch (e) {
        logBackfillError(`[Backfill][MF] Live NAV fetch failed for ${currentCode} on ${date}: ${e?.message || e}`);
      }
    }

    const nearest = nearestOnOrBefore(map, date);
    if (nearest != null) return { price: Number(nearest), source: 'LOCF', origin: 'market_cache_nearest' };
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) return { ...stored, origin: 'prior_daily_value' };
    return { price: 0, source: 'COMPUTED', origin: 'local_compute_fallback' };
  }

  if (inv.asset_type === 'SGB') {
    // SGB: Use NSE historical trade API for historical, fallback to NSE quote for today
    const symbol = inv.ticker_symbol;
    if (!symbol) return { price: 0, source: 'COMPUTED', origin: 'local_compute_missing_symbol' };
    if (!cache.sgb) cache.sgb = new Map();
    if (!cache.sgb.has(symbol)) {
      try {
        const from = cache.sgbRangeBySymbol?.get(symbol) || cache.rangeStart || date;
        const to = cache.rangeEnd || date;

        if (isPhase3ProviderBlocked(cache, date)) {
          const hist = loadSeriesMapFromLocalCache('SGB', symbol, from, to, (row) => row.close);
          cache.sgb.set(symbol, hist);
          warnPhase3ProviderViolation(
            cache,
            `sgb-history:${symbol}`,
            `[Backfill][Phase-3] Provider fetch blocked for SGB ${symbol}; using local cache only`,
            { investmentId: inv.id, portfolioId, date }
          );
        } else {
          const { fetchSGBNseHistoricalRaw } = require('./sgbNseHistorical');

          // Check if DB cache is already fresh enough (historical trade is typically T-1; tolerate 1-day gap)
          // This mirrors fetchStockSeries recency check to avoid re-downloading every run.
          const recentRows = getSeries('SGB', symbol, addDays(to, -5), to).filter((r) => r.close != null);
          const latestCachedDate = recentRows.map((r) => r.date).sort().pop();
          if (latestCachedDate && latestCachedDate >= addDays(to, -1)) {
            // Cache is fresh — load full range from DB, skip HTTP fetch
            const allRows = getSeries('SGB', symbol, from, to).filter((r) => r.close != null);
            const hist = new Map();
            for (const row of allRows) hist.set(row.date, Number(row.close));
            logBackfillInfo(`[SGB][NSE Historical] Loaded ${hist.size} price points for ${symbol} from cache (latest: ${latestCachedDate})`);
            cache.sgb.set(symbol, hist);
          } else {
            logBackfillInfo(`[SGB][NSE Historical] Cache stale or missing for ${symbol} (latest: ${latestCachedDate || 'none'}), fetching up to ${to} from source`);
            const rows = await hydrateHistoricalPriceSeries({
              instrumentType: 'SGB',
              symbol,
              fromDate: from,
              toDate: to,
              freshnessSkipFromDate: runDate,
              sourceLabel: 'NSE_HISTORICAL_TRADE',
              fetchRange: async (missingFrom, missingTo) => fetchSGBNseHistoricalRaw(symbol, missingFrom, missingTo, (level, msg, meta) => {
                if (level === 'error') logBackfillError(`[SGB] ${msg}`, meta);
                else if (level === 'warn') logBackfillWarn(`[SGB] ${msg}`, meta);
                else logBackfillInfo(`[SGB] ${msg}`, meta);
              }),
              mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
            });
            const hist = new Map();
            for (const row of rows) {
              if (row?.date && row.close != null) hist.set(row.date, Number(row.close));
            }
            logBackfillInfo(`[SGB][NSE Historical] Fetched ${hist.size} price points for ${symbol}`);
            cache.sgb.set(symbol, hist);
          }
        }
      } catch (e) {
        logBackfillError(`[SGB][NSE Historical] Failed to fetch prices for ${symbol}: ${e.message}`);
        cache.sgb.set(symbol, new Map());
      }
    }
    const hist = cache.sgb.get(symbol);
    if (hist && hist.has(date)) {
      if (!cache.sgbSourceBySymbol) cache.sgbSourceBySymbol = new Map();
      if (!cache.sgbSourceBySymbol.has(symbol)) {
        const srcMap = new Map();
        const srcRows = getSeries('SGB', symbol, cache.rangeStart || '1900-01-01', cache.rangeEnd || date);
        for (const r of srcRows) {
          if (r?.date) srcMap.set(r.date, String(r.source || '').toUpperCase());
        }
        cache.sgbSourceBySymbol.set(symbol, srcMap);
      }
      const cachedSource = cache.sgbSourceBySymbol.get(symbol)?.get(date);
      const resolvedSource = cachedSource === 'LOCF' ? 'LOCF' : 'LIVE';
      return {
        price: Number(hist.get(date)),
        source: resolvedSource,
        origin: resolvedSource === 'LOCF' ? 'market_cache_exact_locf' : 'market_cache_exact',
      };
    }
    // fallback: try latest NSE quote for today
    if (date === todayIso()) {
      if (isPhase3ProviderBlocked(cache, date)) {
        warnPhase3ProviderViolation(
          cache,
          `sgb-live:${symbol}`,
          `[Backfill][Phase-3] Provider quote blocked for SGB ${symbol}; using local fallback`,
          { investmentId: inv.id, portfolioId, date }
        );
      } else {
        try {
          const live = await fetchSGBLivePrice(symbol);
          if (live && live.price > 0) {
            const sourceDecision = resolvePriceSourceFromProviderDate({
              providerDate: live.date,
              rowDate: date,
              assetType: inv.asset_type,
            });
            return {
              price: Number(live.price),
              source: sourceDecision.priceSource,
              origin: sourceDecision.priceSource === 'LIVE' ? 'provider_live' : 'provider_live_lag',
            };
          }
        } catch (e) {
          logBackfillError(`[Backfill][SGB] Live quote fetch failed for ${symbol} on ${date}: ${e?.message || e}`);
        }
      }
    }
    // fallback: LOCF from hist
    if (hist && hist.size > 0) {
      // find nearest on or before
      const keys = Array.from(hist.keys()).filter(k => k <= date).sort();
      if (keys.length > 0) return { price: Number(hist.get(keys[keys.length-1])), source: 'LOCF', origin: 'market_cache_nearest' };
    }
    // fallback: stored
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) return { ...stored, origin: 'prior_daily_value' };
    return { price: 0, source: 'COMPUTED', origin: 'local_compute_fallback' };
  }
  if (inv.asset_type === 'INDIAN_STOCK' || inv.asset_type === 'FOREIGN_STOCK') {
    if (!cache.stockByInvestment) cache.stockByInvestment = new Map();
    if (!cache.stockByInvestment.has(inv.id)) {
      const localMap = loadInvestmentSeriesMapFromLocalCache(
        inv.id,
        cache.rangeStart || '1900-01-01',
        cache.rangeEnd || date,
        (row) => row.adj_close ?? row.close
      );
      cache.stockByInvestment.set(inv.id, localMap);
    }
    const series = cache.stockByInvestment.get(inv.id) || new Map();
    const exact = series.get(date);
    if (exact != null) {
      // Determine the real cached source for this date. A cache row that is a
      // LOCF carry-forward must NOT be stamped LIVE (that produces stale prices
      // marked LIVE with day_change 0). Only genuine provider closes stay LIVE.
      if (!cache.stockSourceByInvestment) cache.stockSourceByInvestment = new Map();
      if (!cache.stockSourceByInvestment.has(inv.id)) {
        const srcMap = new Map();
        const srcRows = getInvestmentSeries(inv.id, cache.rangeStart || '1900-01-01', cache.rangeEnd || date);
        for (const r of srcRows) {
          if (r?.date) srcMap.set(r.date, String(r.source || '').toUpperCase());
        }
        cache.stockSourceByInvestment.set(inv.id, srcMap);
      }
      const cachedSource = cache.stockSourceByInvestment.get(inv.id)?.get(date);
      const resolvedSource = cachedSource === 'LOCF' ? 'LOCF' : 'LIVE';
      return {
        price: Number(exact),
        source: resolvedSource,
        origin: resolvedSource === 'LOCF' ? 'market_cache_exact_locf' : 'market_cache_exact',
      };
    }

    if (canUseProviderForRunDate(cache, date)) {
      try {
        const quote = await fetchStockPrice(inv.ticker_symbol || inv.symbol || '');
        const live = Number(quote?.price || 0);
        if (Number.isFinite(live) && live > 0) {
          const sourceDecision = resolvePriceSourceFromProviderDate({
            providerDate: quote?.date,
            rowDate: date,
            assetType: inv.asset_type,
          });
          return {
            price: live,
            source: sourceDecision.priceSource,
            origin: sourceDecision.priceSource === 'LIVE' ? 'provider' : 'provider_lag',
          };
        }
      } catch (e) {
        logBackfillError(`[Backfill][Stock] Live quote fetch failed for investment ${inv.id} on ${date}: ${e?.message || e}`);
      }
    }

    const nearest = nearestOnOrBefore(series, date);
    if (nearest != null) {
      return { price: Number(nearest), source: 'LOCF', origin: 'market_cache_nearest' };
    }

    // Fallback 1: nearest investment-level cache entry when in-memory range is sparse.
    const investmentNearest = getInvestmentNearestOnOrBefore(inv.id, date);
    if (investmentNearest?.close != null) {
      return { price: Number(investmentNearest.close), source: 'LOCF', origin: 'investment_cache_nearest' };
    }

    // Fallback 2: last stored daily snapshot for this scope (LOCF carry-forward).
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) {
      return { price: Number(stored.price), source: 'LOCF', origin: 'prior_daily_value' };
    }

    warnBackfillOnce(
      cache,
      `stock-missing-cache:inv-${inv.id}:${portfolioId || 'na'}`,
      `[Backfill][StockPrice] Missing market cache price for investment ${inv.id}`,
      {
        investmentId: inv.id,
        portfolioId,
        date,
        reason: 'missing-investment-market-cache-entry',
      }
    );
    return { price: 0, source: 'COMPUTED', origin: 'local_compute_fallback' };
  }

  if (inv.asset_type === 'NPS') {
    if (inv.nps_fund_code) {
      if (!cache.nps) cache.nps = new Map();
      if (!cache.nps.has(inv.nps_fund_code)) {
        const map = new Map();
        if (isPhase3ProviderBlocked(cache, date)) {
          const localMap = loadSeriesMapFromLocalCache('NPS', inv.nps_fund_code, cache.rangeStart || '1900-01-01', cache.rangeEnd || date, (row) => row.close);
          for (const [d, v] of localMap.entries()) {
            if (isValidNpsNav(v)) map.set(d, Number(v));
          }
          warnPhase3ProviderViolation(
            cache,
            `nps-history:${inv.nps_fund_code}`,
            `[Backfill][Phase-3] Provider fetch blocked for NPS ${inv.nps_fund_code}; using local cache only`,
            { investmentId: inv.id, portfolioId, date }
          );
        } else {
          const history = await fetchNPSHistory(inv.nps_fund_code, cache.rangeStart || date, cache.rangeEnd || date).catch((err) => {
            logBackfillError(`[Backfill][NPS] History fetch failed for ${inv.nps_fund_code}: ${err?.message || err}`);
            return [];
          });
          for (const row of history) {
            const d = normalizeMfDate(row.date);
            if (!d) continue;
            if (!isValidNpsNav(row.nav)) continue;
            map.set(d, Number(row.nav));
          }
        }
        cache.nps.set(inv.nps_fund_code, map);
      }

      const map = cache.nps.get(inv.nps_fund_code);
      const exact = map.get(date);
      if (isValidNpsNav(exact)) return { price: Number(exact), source: 'LIVE', origin: 'market_cache_exact' };

      if (canUseProviderForRunDate(cache, date)) {
        try {
          const live = await fetchNPSNAV(inv.name, inv.nps_fund_code, null);
          const nav = Number(live?.nav || 0);
          if (isValidNpsNav(nav)) {
            const navDate = normalizeMfDate(live?.date);
            return {
              price: nav,
              source: navDate === date ? 'LIVE' : 'LOCF',
              origin: navDate === date ? 'provider' : 'provider_lag',
            };
          }
        } catch (e) {
          logBackfillError(`[Backfill][NPS] Live NAV fetch failed for ${inv.nps_fund_code} on ${date}: ${e?.message || e}`);
        }
      }

      const nearest = nearestOnOrBefore(map, date);
      if (isValidNpsNav(nearest)) return { price: Number(nearest), source: 'LOCF', origin: 'market_cache_nearest' };
    }

    const row = db.prepare(`
      SELECT price_per_unit FROM transactions
      WHERE investment_id = ?
        AND transaction_date <= ?
        AND price_per_unit > 0
        AND ABS(price_per_unit - 99.99) > 0.000001
      ORDER BY transaction_date DESC, id DESC
      LIMIT 1
    `).get(inv.id, date);
    if (isValidNpsNav(row?.price_per_unit)) return { price: Number(row.price_per_unit), source: 'COMPUTED', origin: 'transaction_compute' };
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && isValidNpsNav(stored.price)) return { ...stored, origin: 'prior_daily_value' };
    return { price: 0, source: 'COMPUTED', origin: 'local_compute_fallback' };
  }

  return { price: 0, source: 'COMPUTED', origin: 'local_compute_fallback' };
}

function getRateRows(db, rateType) {
  return db.prepare(
    'SELECT rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
  ).all(rateType);
}

function getProvidentValue(db, inv, date, portfolioId) {
  const portfolioFilter = portfolioId != null ? ' AND portfolio_id = ?' : '';
  const params = portfolioId != null ? [inv.id, date, portfolioId] : [inv.id, date];
  const txns = db.prepare(`
    SELECT date(transaction_date) AS transaction_date, transaction_type, amount
    FROM transactions
    WHERE investment_id = ? AND date(transaction_date) <= ?${portfolioFilter}
    ORDER BY transaction_date ASC, id ASC
  `).all(...params);

  if (!txns.length && !(Number(inv.opening_balance) > 0)) return 0;

  const fromDate = txns.length ? txns[0].transaction_date : date;
  const rateRows = getRateRows(db, inv.asset_type);

  if (inv.asset_type === 'PF') {
    return Number(calculatePfValueAsOfDate({
      openingBalance: Number(inv.opening_balance || 0),
      transactions: txns,
      rateRows,
      fromDate,
      asOfDate: date,
      // Existing INTEREST rows in PF statements are year-end credits that are
      // already represented in historical postings. Recomputing interest while
      // also including those rows double-counts and inflates daily values.
      ignoreExistingInterest: true,
      includeTransferTransactions: true,
    }) || 0);
  }

  if (inv.asset_type === 'PPF' || inv.asset_type === 'SSY') {
    return Number(calculateSmallSavingsValueAsOfDate({
      openingBalance: Number(inv.opening_balance || 0),
      transactions: txns,
      rateRows,
      fromDate,
      asOfDate: date,
      includeTransferTransactions: true,
      interestBaseMethod: inv.asset_type === 'SSY' ? 'month_end_balance' : 'min_balance_between_5th_and_month_end',
      annualRounding: true,
    }) || 0);
  }

  const preview = calculateSmallSavingsInterestPreview({
    openingBalance: Number(inv.opening_balance || 0),
    transactions: txns,
    rateRows,
    fromDate,
    toDate: date,
    ignoreExistingInterest: false,
    includeTransferTransactions: true,
    interestBaseMethod: inv.asset_type === 'SSY' ? 'month_end_balance' : 'min_balance_between_5th_and_month_end',
    annualRounding: inv.asset_type === 'SSY' || inv.asset_type === 'PPF',
  });
  return Number(preview.closingBalance || 0);
}

function upsertDailyRow(db, row, statements = null, auditContext = null) {
  // Only write portfolio-scoped rows (portfolio_id NOT NULL)
  if (row.portfolio_id == null) return;

  const normalizedRow = {
    ...row,
    price_per_unit: quantizeForStorage(row.price_per_unit),
    total_units: quantizeForStorage(row.total_units),
    current_value: quantizeForStorage(row.current_value),
    invested_amount: quantizeForStorage(row.invested_amount),
    realized_proceeds: quantizeForStorage(row.realized_proceeds),
    profit_loss: quantizeForStorage(row.profit_loss),
    day_change: quantizeForStorage(row.day_change),
  };

  const upsertScoped = statements?.upsertScoped || db.prepare(`
    INSERT INTO investment_metrics_daily (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_proceeds, profit_loss, price_source, day_change, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
      price_per_unit = excluded.price_per_unit,
      total_units = excluded.total_units,
      current_value = excluded.current_value,
      invested_amount = excluded.invested_amount,
      realized_proceeds = excluded.realized_proceeds,
      profit_loss = excluded.profit_loss,
      price_source = excluded.price_source,
      day_change = excluded.day_change,
      updated_at = datetime('now')
  `);

  const selectExistingScoped = statements?.selectExistingScoped || db.prepare(`
    SELECT price_per_unit, current_value, price_source
    FROM investment_metrics_daily
    WHERE investment_id = ? AND portfolio_id = ? AND date = ?
    LIMIT 1
  `);

  const existing = selectExistingScoped.get(normalizedRow.investment_id, normalizedRow.portfolio_id, normalizedRow.date);
  let effectivePriceSource = normalizedRow.price_source;
  if (String(existing?.price_source || '').toUpperCase() === 'LIVE' && String(normalizedRow.price_source || '').toUpperCase() === 'LOCF') {
    effectivePriceSource = 'LIVE';
    logBackfillWarn('[Backfill][SourceGuard] Prevented LIVE to LOCF downgrade', {
      investmentId: normalizedRow.investment_id,
      investmentName: auditContext?.investmentName || null,
      portfolioId: normalizedRow.portfolio_id,
      date: normalizedRow.date,
      previousSource: existing?.price_source || null,
      attemptedSource: normalizedRow.price_source,
      persistedSource: effectivePriceSource,
      sourceOrigin: auditContext?.sourceOrigin || null,
      runDate: auditContext?.runDate || null,
      existingPricePerUnit: Number(existing?.price_per_unit || 0),
      attemptedPricePerUnit: normalizedRow.price_per_unit,
      phase: 'backfill_step3',
    });
  }

  upsertScoped.run(
    normalizedRow.investment_id,
    normalizedRow.portfolio_id,
    normalizedRow.date,
    normalizedRow.price_per_unit,
    normalizedRow.total_units,
    normalizedRow.current_value,
    normalizedRow.invested_amount,
    normalizedRow.realized_proceeds,
    normalizedRow.profit_loss,
    effectivePriceSource,
    normalizedRow.day_change
  );

  if (ENABLE_ROW_WRITE_AUDIT) {
    logBackfillInfo('[Audit] dv.write', {
      action: existing ? 'update' : 'insert',
      investmentId: normalizedRow.investment_id,
      investmentName: auditContext?.investmentName || null,
      portfolioId: normalizedRow.portfolio_id,
      date: normalizedRow.date,
      source: effectivePriceSource,
      sourceOrigin: auditContext?.sourceOrigin || null,
      pricePerUnit: normalizedRow.price_per_unit,
      currentValue: normalizedRow.current_value,
      previousSource: existing?.price_source || null,
      phase: 'backfill_step3',
      runDate: auditContext?.runDate || null,
    });
  }
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

async function recomputeScopeRows(db, inv, portfolioId, fromDate, toDate, cache, onProgress = null, options = {}) {
    // Only handle portfolio-scoped rows (portfolio_id NOT NULL)
    if (portfolioId == null) return 0;

    const dailyStatements = {
      upsertScoped: db.prepare(`
        INSERT INTO investment_metrics_daily (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_proceeds, profit_loss, price_source, day_change, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
          price_per_unit = excluded.price_per_unit,
          total_units = excluded.total_units,
          current_value = excluded.current_value,
          invested_amount = excluded.invested_amount,
          realized_proceeds = excluded.realized_proceeds,
          profit_loss = excluded.profit_loss,
          price_source = excluded.price_source,
          day_change = excluded.day_change,
          updated_at = datetime('now')
      `),
      selectExistingScoped: db.prepare(`
        SELECT price_per_unit, current_value, price_source
        FROM investment_metrics_daily
        WHERE investment_id = ? AND portfolio_id = ? AND date = ?
        LIMIT 1
      `),
      deleteScopedDate: db.prepare(`
        DELETE FROM investment_metrics_daily
        WHERE investment_id = ? AND portfolio_id = ? AND date = ?
      `),
      deleteScopedRange: db.prepare(`
        DELETE FROM investment_metrics_daily
        WHERE investment_id = ? AND portfolio_id = ? AND date >= ? AND date <= ?
      `),
    };

  const dates = eachDate(fromDate, toDate);
  const txRows = db.prepare(`
    SELECT
      date(transaction_date) AS tx_date,
      UPPER(transaction_type) AS transaction_type,
      COALESCE(units, 0) AS units,
      COALESCE(amount, 0) AS amount,
      COALESCE(fees, 0) AS fees,
      id
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date(transaction_date) <= ?
    ORDER BY date(transaction_date) ASC, id ASC
  `).all(inv.id, portfolioId, toDate);

  const latestTxnDate = txRows.length ? txRows[txRows.length - 1].tx_date : null;

  const unitInflowTypes = new Set([
    'BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN',
    'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE',
  ]);
  const unitOutflowTypes = new Set([
    'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC',
  ]);
  const investedInflowTypes = new Set(INVESTED_AMOUNT_INFLOW_TYPES);
  const realizedCashflowTypes = new Set(
    (inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY')
      ? REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL
      : REALIZED_CASHFLOW_TYPES
  );
  const netFlowPositiveTypes = new Set(EXTERNAL_CASH_IN_TYPES);
  const netFlowNegativeTypes = new Set(EXTERNAL_CASH_OUT_TYPES);

  // Bond coupon income by date (for total-return day_change adjustment)
  const bondIncomeByDate = new Map();
  if (inv.asset_type === 'BOND') {
    for (const tx of txRows) {
      if (String(tx.transaction_type || '').toUpperCase() === 'INTEREST' && tx.tx_date >= fromDate) {
        bondIncomeByDate.set(tx.tx_date, (bondIncomeByDate.get(tx.tx_date) || 0) + Number(tx.amount || 0));
      }
    }
  }

  const byDate = new Map();
  let cumulativeUnits = 0;
  let cumulativeInvested = 0;
  let cumulativeRealized = 0;
  let firstUnitInflow = null;

  const applyTxToCumulative = (tx) => {
    const type = String(tx.transaction_type || '').toUpperCase();
    const units = Number(tx.units || 0);
    const amount = Number(tx.amount || 0);
    const fees = Number(tx.fees || 0);

    let unitsDelta = 0;
    if (unitInflowTypes.has(type)) unitsDelta += units;
    else if (unitOutflowTypes.has(type)) unitsDelta -= units;

    const investedDelta = investedInflowTypes.has(type) ? (amount + fees) : 0;
    const realizedDelta = realizedCashflowTypes.has(type) ? (amount - fees) : 0;

    let netFlowDelta = 0;
    if (netFlowPositiveTypes.has(type)) netFlowDelta = amount;
    else if (netFlowNegativeTypes.has(type)) netFlowDelta = -amount;
    else if (type === 'TDS') netFlowDelta = -Math.abs(amount);

    cumulativeUnits += unitsDelta;
    cumulativeInvested += investedDelta;
    cumulativeRealized += realizedDelta;

    return { unitsDelta, investedDelta, realizedDelta, netFlowDelta };
  };

  for (const tx of txRows) {
    if (!firstUnitInflow && Number(tx.units || 0) > 0) {
      firstUnitInflow = {
        date: tx.tx_date,
        transaction_type: String(tx.transaction_type || '').toUpperCase(),
      };
    }

    const delta = applyTxToCumulative(tx);
    if (tx.tx_date >= fromDate) {
      const day = byDate.get(tx.tx_date) || { unitsDelta: 0, investedDelta: 0, realizedDelta: 0, netFlowDelta: 0 };
      day.unitsDelta += delta.unitsDelta;
      day.investedDelta += delta.investedDelta;
      day.realizedDelta += delta.realizedDelta;
      day.netFlowDelta += delta.netFlowDelta;
      byDate.set(tx.tx_date, day);
    }
  }
  const netUnitsAsOfToDate = Number(cumulativeUnits || 0);

  // Convert to baseline state as of day before fromDate.
  cumulativeUnits = 0;
  cumulativeInvested = 0;
  cumulativeRealized = 0;
  for (const tx of txRows) {
    if (tx.tx_date >= fromDate) break;
    const type = String(tx.transaction_type || '').toUpperCase();
    const units = Number(tx.units || 0);
    const amount = Number(tx.amount || 0);
    const fees = Number(tx.fees || 0);

    if (unitInflowTypes.has(type)) cumulativeUnits += units;
    else if (unitOutflowTypes.has(type)) cumulativeUnits -= units;

    if (investedInflowTypes.has(type)) cumulativeInvested += (amount + fees);
    if (realizedCashflowTypes.has(type)) cumulativeRealized += (amount - fees);
  }

  const prevBeforeRange = db.prepare(
    'SELECT current_value FROM investment_metrics_daily WHERE investment_id = ? AND portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
  ).get(inv.id, portfolioId, fromDate);
  let prevValue = Number(prevBeforeRange?.current_value || 0);

  let written = 0;
  let lastNonZeroDate = null;
  let exitDate = null;
  let locfMarketStreak = 0;
  let locfStreakStartDate = null;
  const dayStride = progressLogStride(dates.length, 20);
  const isProvidentAsset = inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY';
  const isMarketLinkedAsset = ['INDIAN_STOCK', 'FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB'].includes(String(inv.asset_type || ''));
  const trackLocfStreak = ['INDIAN_STOCK', 'FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB'].includes(String(inv.asset_type || ''));
  const suppressRunDateWritesForMarketLinked = options.suppressRunDateWritesForMarketLinked === true;
  const suppressedRunDateAssetTypes = Array.isArray(options.suppressedRunDateAssetTypes)
    ? new Set(options.suppressedRunDateAssetTypes.map((assetType) => String(assetType || '').toUpperCase()))
    : null;
  let carriedNetFlowSinceLastWrite = 0;
  for (const date of dates) {
    const dayDelta = byDate.get(date) || { unitsDelta: 0, investedDelta: 0, realizedDelta: 0, netFlowDelta: 0 };
    cumulativeUnits += Number(dayDelta.unitsDelta || 0);
    cumulativeInvested += Number(dayDelta.investedDelta || 0);
    cumulativeRealized += Number(dayDelta.realizedDelta || 0);

    const units = Number(cumulativeUnits || 0);
    const invested = Number(cumulativeInvested || 0);
    const realized = Number(cumulativeRealized || 0);
    const netFlow = Number(dayDelta.netFlowDelta || 0);
    carriedNetFlowSinceLastWrite += netFlow;

    // Stop writing trailing zero-unit rows after exit for all unit-based assets.
    // Use the exit epsilon (not strict <= 0) so tiny floating-point unit residuals
    // from fractional buy/sell quantities still trigger the trailing-row cleanup.
    if (latestTxnDate && date > latestTxnDate && units <= EXITED_UNITS_EPSILON && !isProvidentAsset) {
      written += dailyStatements.deleteScopedRange.run(inv.id, portfolioId, date, toDate).changes;
      break;
    }

    const hasUnitTransactionToday = Math.abs(Number(dayDelta.unitsDelta || 0)) > EXITED_UNITS_EPSILON;
    const shouldSkipExitedGapDate = !isProvidentAsset && units <= EXITED_UNITS_EPSILON && !hasUnitTransactionToday;
    if (shouldSkipExitedGapDate) {
      locfMarketStreak = 0;
      locfStreakStartDate = null;
      prevValue = 0;
      written += dailyStatements.deleteScopedDate.run(inv.id, portfolioId, date).changes;

      if (latestTxnDate && date > latestTxnDate) {
        break;
      }
      continue;
    }

    // For market-linked assets, closed-market days are retained as LOCF rows
    // by price resolution fallback paths in getPriceForDate().

    let price = 0;
    let priceSource = 'COMPUTED';
    let currentValue = 0;
    let totalUnits = units;
    const priced = await getPriceForDate(db, inv, date, cache, portfolioId);
    price = Number(priced.price || 0);
    priceSource = priced.source || 'COMPUTED';
    let sourceOrigin = priced.origin || 'local_compute';

    if (isProvidentAsset) {
      currentValue = getProvidentValue(db, inv, date, portfolioId);
      totalUnits = 1;
      if (!price) {
        const rateRow = db.prepare(
          'SELECT rate FROM interest_rates WHERE rate_type = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1'
        ).get(inv.asset_type, date, date);
        price = Number(rateRow?.rate || 0);
      }
      priceSource = 'COMPUTED';
      sourceOrigin = 'local_compute_interest';
    } else if (inv.asset_type === 'BOND') {
      const accrual = computeBondAccruedCoupon({
        investment: inv,
        transactions: txRows,
        asOfDate: date,
        dayCount: 365,
      });

      currentValue = (units * price) + Number(accrual?.accruedCoupon || 0);

      if (accrual?.meta?.missingExpectedCouponPayment) {
        warnBackfillOnce(
          cache,
          `bond-missing-coupon:${inv.id}:${portfolioId}:${date}`,
          '[Backfill][BondAccrual] Expected coupon transaction missing on scheduled date',
          {
            investmentId: inv.id,
            investmentName: inv.name,
            portfolioId,
            date,
            couponFrequency: accrual?.meta?.couponFrequency || null,
            expectedCouponDate: accrual?.meta?.expectedCouponDate || null,
            lastCouponDate: accrual?.meta?.lastCouponDate || null,
          }
        );
      }
    } else if (inv.asset_type === 'FOREIGN_STOCK') {
      const fxKey = date;
      // In-memory FX map is a DB-hydrated fast-path; fallback to DB cache when missing.
      let fxRate = cache.fx.get(fxKey);
      if (!(fxRate != null && Number.isFinite(Number(fxRate)) && Number(fxRate) > 0)) {
        fxRate = getLocalFxRateOnOrBefore(date);
      }
      if (!(fxRate != null && Number.isFinite(Number(fxRate)) && Number(fxRate) > 0)) {
        if (isPhase3ProviderBlocked(cache, date)) {
          warnPhase3ProviderViolation(
            cache,
            `fx-history:${date}`,
            `[Backfill][Phase-3] Provider fetch blocked for USDINR=X ${date}; using local cache only`,
            { investmentId: inv.id, portfolioId, date }
          );
          fxRate = 0;
        } else {
          fxRate = await fetchHistoricalUSDToINR(date).catch((err) => {
            logBackfillError(`[Backfill][FX] USDINR history fetch failed for ${date}: ${err?.message || err}`);
            return 0;
          });
        }
      }
      cache.fx.set(fxKey, Number(fxRate || 0));
      currentValue = units * price * Number(fxRate || 0);
    } else {
      currentValue = units * price;
    }

    const reinvestType = inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY';
    const realizedGain = inv.asset_type === 'PF'
      ? realized
      : (reinvestType ? 0 : realized);

    const profitLoss = reinvestType
      ? currentValue - invested
      : currentValue + realized - invested;
    const profitLossPct = invested > 0 ? (profitLoss / invested) * 100 : 0;

    if (units > 0.000001) {
      lastNonZeroDate = date;
    } else if (latestTxnDate && date >= latestTxnDate && !exitDate) {
      exitDate = date;
    }

    const bondIncomeToday = bondIncomeByDate.get(date) || 0;
    const dayChange = currentValue - prevValue - carriedNetFlowSinceLastWrite + bondIncomeToday;
    const dayChangePct = prevValue > 0 ? (dayChange / prevValue) * 100 : 0;

    const isRunDateWriteSuppressed = !suppressedRunDateAssetTypes
      || suppressedRunDateAssetTypes.has(String(inv.asset_type || '').toUpperCase());
    if (suppressRunDateWritesForMarketLinked && isMarketLinkedAsset && isRunDateWriteSuppressed && date === toDate) {
      continue;
    }

    upsertDailyRow(db, {
      investment_id: inv.id,
      portfolio_id: portfolioId,
      date,
      price_per_unit: price,
      total_units: isProvidentAsset
        ? 1
        : units,
      current_value: currentValue,
      invested_amount: invested,
      realized_proceeds: realizedGain,
      profit_loss: profitLoss,
      price_source: priceSource,
      day_change: dayChange,
    }, dailyStatements, {
      investmentName: inv.name,
      runDate: cache?.runDate || null,
      sourceOrigin,
    });

    prevValue = currentValue;
    carriedNetFlowSinceLastWrite = 0;

    const canTrackLocfStreak = trackLocfStreak
      && units > EXITED_UNITS_EPSILON
      && (!latestTxnDate || date <= latestTxnDate);
    if (canTrackLocfStreak && isMarketSessionDate(date, db, cache, inv.asset_type)) {
      if (priceSource === 'LOCF') {
        if (locfMarketStreak === 0) locfStreakStartDate = date;
        locfMarketStreak += 1;
        if (locfMarketStreak >= LOCF_STREAK_WARN_SESSIONS) {
          logBackfillWarn('[Backfill][LOCF] Unexpected LOCF streak reached threshold', {
            investmentId: inv.id,
            investmentName: inv.name,
            portfolioId,
            assetType: inv.asset_type,
            streak: locfMarketStreak,
            streakStartDate: locfStreakStartDate,
            streakEndDate: date,
          });
        }
      } else {
        locfMarketStreak = 0;
        locfStreakStartDate = null;
      }
    } else {
      locfMarketStreak = 0;
      locfStreakStartDate = null;
    }

    written += 1;

    if (typeof onProgress === 'function' && (written === dates.length || written % dayStride === 0)) {
      onProgress({
        processedDays: written,
        totalDays: dates.length,
        date,
      });
    }

    // Yield periodically so heartbeat/log updates are not starved by long sync loops.
    if (written % 200 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (latestTxnDate && (lastNonZeroDate || exitDate)) {
    db.prepare(
      'UPDATE investments SET last_active_date = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(lastNonZeroDate || exitDate || latestTxnDate, inv.id);
  } else if (!latestTxnDate) {
    db.prepare(
      'UPDATE investments SET last_active_date = NULL, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(inv.id);
  }

  return written;
}

function holdingUnitsAtDate(db, investmentId, portfolioId, date, excludeSameDayTrading = false, excludeSameDayCorporateUnitAdds = false) {
  const rows = db.prepare(`
    SELECT transaction_type, COALESCE(units, 0) AS units, transaction_date
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ?
    ORDER BY transaction_date ASC, id ASC
  `).all(investmentId, portfolioId, date);

  const corporateTypes = new Set(['BONUS', 'SPLIT', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST']);
  const sameDayCorporateUnitAdds = new Set(['BONUS', 'SPLIT', 'RIGHTS']);
  let units = 0;
  for (const row of rows) {
    if (excludeSameDayTrading && row.transaction_date === date && !corporateTypes.has(row.transaction_type)) {
      continue;
    }
    if (excludeSameDayCorporateUnitAdds && row.transaction_date === date && sameDayCorporateUnitAdds.has(row.transaction_type)) {
      continue;
    }

    if (['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'VEST', 'ESPP_PURCHASE'].includes(row.transaction_type)) {
      units += Number(row.units || 0);
    } else if (['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION', 'CHARGES', 'AMC'].includes(row.transaction_type)) {
      units -= Number(row.units || 0);
    }
  }
  return Math.round(units * 1000) / 1000;
}

function toRecordSnapshot(row) {
  if (!row) return null;
  return {
    units: Number(row.units == null ? 0 : row.units),
    pricePerUnit: Number(row.price_per_unit == null ? 0 : row.price_per_unit),
    amount: Number(row.amount == null ? 0 : row.amount),
    notes: row.notes || null,
    broker: row.broker || null,
    fxRate: row.exchange_rate_used == null ? null : Number(row.exchange_rate_used),
    usdAmount: row.usd_amount == null ? null : Number(row.usd_amount),
  };
}

function loadLocalSplitEventsForInvestment(db, investmentId, cache) {
  if (!cache.localSplitEventsByInvestment) cache.localSplitEventsByInvestment = new Map();
  if (cache.localSplitEventsByInvestment.has(investmentId)) {
    return cache.localSplitEventsByInvestment.get(investmentId);
  }

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT date(event_date) AS event_date, ratio
      FROM investment_split_events
      WHERE investment_id = ?
      ORDER BY date(event_date) ASC
    `).all(investmentId);
  } catch (_e) {
    rows = [];
  }

  const events = rows
    .map((row) => ({
      date: String(row?.event_date || ''),
      ratio: Number(row?.ratio || 0),
    }))
    .filter((row) => row.date && Number.isFinite(row.ratio) && row.ratio > 1)
    .sort((a, b) => a.date.localeCompare(b.date));

  cache.localSplitEventsByInvestment.set(investmentId, events);
  return events;
}

function getSplitAdjustmentFactorForDividend(splitEvents, payoutDate) {
  if (!Array.isArray(splitEvents) || !splitEvents.length || !payoutDate) return 1;
  let factor = 1;
  for (const event of splitEvents) {
    if (!event?.date || !(event?.ratio > 1)) continue;
    if (event.date > payoutDate) factor *= Number(event.ratio);
  }
  return factor > 0 ? factor : 1;
}

function gcdInt(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function formatCorporateActionRatioLabel(ratio) {
  const r = Number(ratio || 0);
  if (!(r > 1)) return '1:1';

  const maxDen = 1000;
  let bestNum = 0;
  let bestDen = 1;
  let bestErr = Number.POSITIVE_INFINITY;

  for (let den = 1; den <= maxDen; den += 1) {
    const num = Math.round(r * den);
    if (!(num > den)) continue;
    const approx = num / den;
    const err = Math.abs(approx - r);
    if (err < bestErr) {
      bestErr = err;
      bestNum = num;
      bestDen = den;
      if (err < 1e-8) break;
    }
  }

  if (!(bestNum > bestDen) || bestErr > 1e-4) {
    const rounded = Math.round(r * 1000) / 1000;
    return `${rounded}:1`;
  }

  const g = gcdInt(bestNum, bestDen);
  return `${Math.trunc(bestNum / g)}:${Math.trunc(bestDen / g)}`;
}

function buildCorporateActionSuggestionFingerprint(change) {
  const parts = [
    String(change?.action || ''),
    String(change?.investmentId || ''),
    String(change?.portfolioId == null ? '' : change?.portfolioId),
    String(change?.transactionType || ''),
    String(change?.transactionDate || ''),
    String(change?.recordId == null ? '' : change?.recordId),
  ];
  return parts.join('|');
}

function persistCorporateActionSuggestions(db, changes = [], source = 'auto_backfill') {
  const rows = Array.isArray(changes) ? changes : [];
  if (!rows.length) return { queued: 0, refreshed: 0, suppressed: 0, total: 0 };

  const findLatestByFingerprint = db.prepare(`
    SELECT id, status
    FROM corporate_action_suggestions
    WHERE fingerprint = ?
    ORDER BY id DESC
    LIMIT 1
  `);
  const insertSuggestion = db.prepare(`
    INSERT INTO corporate_action_suggestions (
      source,
      action,
      investment_id,
      portfolio_id,
      transaction_type,
      transaction_date,
      fingerprint,
      payload_json,
      notes,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `);
  const refreshPendingSuggestion = db.prepare(`
    UPDATE corporate_action_suggestions
    SET payload_json = ?,
        notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  let queued = 0;
  let refreshed = 0;
  let suppressed = 0;

  const run = db.transaction(() => {
    for (const change of rows) {
      const fingerprint = buildCorporateActionSuggestionFingerprint(change);
      const existing = findLatestByFingerprint.get(fingerprint);
      const payload = JSON.stringify(change);
      const notes = change?.next?.notes || change?.previous?.notes || null;

      if (existing?.status === 'pending') {
        refreshPendingSuggestion.run(payload, notes, existing.id);
        refreshed += 1;
        continue;
      }

      // Respect explicit user decisions from previous runs.
      if (existing?.status === 'rejected' || existing?.status === 'applied') {
        suppressed += 1;
        continue;
      }

      insertSuggestion.run(
        source,
        change.action,
        change.investmentId,
        change.portfolioId,
        change.transactionType,
        change.transactionDate,
        fingerprint,
        payload,
        notes
      );
      queued += 1;
    }
  });

  run();
  return { queued, refreshed, suppressed, total: rows.length };
}

async function syncCorporateActionsForScope(db, inv, portfolioId, fromDate, toDate, cache, options = {}) {
  const dryRun = options?.dryRun === true;
  const isStockAsset = inv.asset_type === 'INDIAN_STOCK' || inv.asset_type === 'FOREIGN_STOCK';
  const isCouponAsset = inv.asset_type === 'BOND' || inv.asset_type === 'SGB';
  if (portfolioId == null) return { inserted: 0, updated: 0, modified: 0, earliestChangedDate: null, caChanges: [] };
  if (!isStockAsset && !isCouponAsset) {
    return { inserted: 0, updated: 0, modified: 0, earliestChangedDate: null, caChanges: [] };
  }
  if (isStockAsset && !inv.ticker_symbol) {
    logBackfillWarn('[Backfill][CA] Skipping CA sync due to missing ticker symbol', {
      investmentId: inv.id,
      investmentName: inv.name,
      portfolioId,
      fromDate,
      toDate,
    });
    return { inserted: 0, updated: 0, modified: 0, earliestChangedDate: null, caChanges: [] };
  }
  if (!fromDate || !toDate || fromDate > toDate) {
    logBackfillWarn('[Backfill][CA] Skipping CA sync due to invalid date window', {
      investmentId: inv.id,
      investmentName: inv.name,
      portfolioId,
      fromDate: fromDate || null,
      toDate: toDate || null,
    });
    return { inserted: 0, updated: 0, modified: 0, earliestChangedDate: null, caChanges: [] };
  }

  const ticker = isStockAsset
    ? (inv.asset_type === 'INDIAN_STOCK' && !inv.ticker_symbol.includes('.')
      ? `${inv.ticker_symbol}.NS`
      : inv.ticker_symbol)
    : null;

  const CORPORATE_TYPES = new Set(['BONUS', 'SPLIT', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST']);
  const SAME_DAY_UNIT_ADD_CORPORATE = new Set(['BONUS', 'SPLIT', 'RIGHTS']);
  const UNIT_ADD_TYPES = new Set(['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'VEST', 'ESPP_PURCHASE']);
  const UNIT_SUB_TYPES = new Set(['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION', 'CHARGES', 'AMC']);

  const holdingRows = db.prepare(`
    SELECT UPPER(transaction_type) AS transaction_type, COALESCE(units, 0) AS units, date(transaction_date) AS transaction_date
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date(transaction_date) <= ?
    ORDER BY date(transaction_date) ASC, id ASC
  `).all(inv.id, portfolioId, toDate);

  const dayAgg = new Map();
  for (const row of holdingRows) {
    const txType = String(row.transaction_type || '').toUpperCase();
    const rawUnits = Number(row.units || 0);
    if (!Number.isFinite(rawUnits) || !row.transaction_date) continue;

    let delta = 0;
    if (UNIT_ADD_TYPES.has(txType)) delta = rawUnits;
    else if (UNIT_SUB_TYPES.has(txType)) delta = -rawUnits;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) continue;

    const dateKey = String(row.transaction_date);
    const existing = dayAgg.get(dateKey) || {
      netDelta: 0,
      sameDayTradingDelta: 0,
      sameDayCorporateUnitAddsDelta: 0,
    };

    existing.netDelta += delta;
    if (!CORPORATE_TYPES.has(txType)) {
      existing.sameDayTradingDelta += delta;
    }
    if (SAME_DAY_UNIT_ADD_CORPORATE.has(txType)) {
      existing.sameDayCorporateUnitAddsDelta += delta;
    }
    dayAgg.set(dateKey, existing);
  }

  const dayKeys = Array.from(dayAgg.keys()).sort();
  const cumulativeByIndex = [];
  let running = 0;
  for (let i = 0; i < dayKeys.length; i += 1) {
    running += Number(dayAgg.get(dayKeys[i])?.netDelta || 0);
    cumulativeByIndex[i] = running;
  }

  const findLastDayIndexOnOrBefore = (date) => {
    let lo = 0;
    let hi = dayKeys.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (dayKeys[mid] <= date) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  const holdingUnitsAtDateFast = (date, excludeSameDayTrading = false, excludeSameDayCorporateUnitAdds = false) => {
    if (!date || !dayKeys.length) return 0;
    const idx = findLastDayIndexOnOrBefore(date);
    if (idx < 0) return 0;

    let units = Number(cumulativeByIndex[idx] || 0);
    if (dayKeys[idx] === date) {
      const agg = dayAgg.get(date);
      if (excludeSameDayTrading) {
        units -= Number(agg?.sameDayTradingDelta || 0);
      }
      if (excludeSameDayCorporateUnitAdds) {
        units -= Number(agg?.sameDayCorporateUnitAddsDelta || 0);
      }
    }

    return Math.round(units * 1000) / 1000;
  };

  const insertTxn = db.prepare(`
    INSERT INTO transactions (
      investment_id,
      portfolio_id,
      transaction_type,
      transaction_date,
      units,
      price_per_unit,
      amount,
      fees,
      notes,
      broker,
      exchange_rate_used,
      usd_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);

  const selectByKey = db.prepare(`
    SELECT id, locked, units, price_per_unit, amount, notes, broker, exchange_rate_used, usd_amount
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND transaction_date = ?
      AND transaction_type = ?
    ORDER BY id ASC
  `);

  const selectNearbyInterestRows = db.prepare(`
    SELECT id, locked, units, price_per_unit, amount, notes, broker, exchange_rate_used, usd_amount,
           date(transaction_date) AS transaction_date
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND transaction_type = 'INTEREST'
      AND date(transaction_date) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
    ORDER BY date(transaction_date) ASC, id ASC
  `);

  const updateById = db.prepare(`
    UPDATE transactions
    SET units = ?,
        price_per_unit = ?,
        amount = ?,
        notes = ?,
        broker = ?,
        exchange_rate_used = ?,
        usd_amount = ?
    WHERE id = ?
  `);

  const deleteById = db.prepare('DELETE FROM transactions WHERE id = ?');

  const nearlyEqual = (a, b) => {
    const x = Number(a == null ? 0 : a);
    const y = Number(b == null ? 0 : b);
    return Math.abs(x - y) < 0.000001;
  };

  const diffIsoDays = (leftDate, rightDate) => {
    const left = new Date(`${leftDate}T00:00:00.000Z`).getTime();
    const right = new Date(`${rightDate}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    return Math.round((left - right) / 86400000);
  };

  function upsertCorporateActionTxn(desired) {
    const normalizedDesired = {
      ...desired,
      units: quantizeForStorage(desired.units),
      pricePerUnit: quantizeForStorage(desired.pricePerUnit),
      amount: quantizeForStorage(desired.amount),
      fxRate: quantizeNullableForStorage(desired.fxRate),
      usdAmount: quantizeNullableForStorage(desired.usdAmount),
    };

    let rows = selectByKey.all(
      normalizedDesired.investmentId,
      normalizedDesired.portfolioId,
      normalizedDesired.date,
      normalizedDesired.transactionType
    );

    if (!rows.length && normalizedDesired.transactionType === 'INTEREST') {
      rows = selectNearbyInterestRows.all(
        normalizedDesired.investmentId,
        normalizedDesired.portfolioId,
        normalizedDesired.date,
        normalizedDesired.date
      ).sort((a, b) => {
        const leftDelta = Math.abs(diffIsoDays(a.transaction_date, normalizedDesired.date) ?? 999);
        const rightDelta = Math.abs(diffIsoDays(b.transaction_date, normalizedDesired.date) ?? 999);
        return leftDelta - rightDelta || Number(a.id) - Number(b.id);
      });
    }

    if (!rows.length) {
      if (dryRun) {
        return {
          changeType: 'inserted',
          recordId: null,
          previous: null,
          next: {
            units: Number(normalizedDesired.units == null ? 0 : normalizedDesired.units),
            pricePerUnit: Number(normalizedDesired.pricePerUnit == null ? 0 : normalizedDesired.pricePerUnit),
            amount: Number(normalizedDesired.amount == null ? 0 : normalizedDesired.amount),
            notes: normalizedDesired.notes || null,
            broker: normalizedDesired.broker || null,
            fxRate: normalizedDesired.fxRate == null ? null : Number(normalizedDesired.fxRate),
            usdAmount: normalizedDesired.usdAmount == null ? null : Number(normalizedDesired.usdAmount),
          },
          deletedDuplicateIds: [],
          locked: false,
        };
      }

      const insertRes = insertTxn.run(
        normalizedDesired.investmentId,
        normalizedDesired.portfolioId,
        normalizedDesired.transactionType,
        normalizedDesired.date,
        normalizedDesired.units,
        normalizedDesired.pricePerUnit,
        normalizedDesired.amount,
        normalizedDesired.notes,
        normalizedDesired.broker,
        normalizedDesired.fxRate,
        normalizedDesired.usdAmount
      );
      return {
        changeType: 'inserted',
        recordId: Number(insertRes.lastInsertRowid),
        previous: null,
        next: {
          units: Number(normalizedDesired.units == null ? 0 : normalizedDesired.units),
          pricePerUnit: Number(normalizedDesired.pricePerUnit == null ? 0 : normalizedDesired.pricePerUnit),
          amount: Number(normalizedDesired.amount == null ? 0 : normalizedDesired.amount),
          notes: normalizedDesired.notes || null,
          broker: normalizedDesired.broker || null,
          fxRate: normalizedDesired.fxRate == null ? null : Number(normalizedDesired.fxRate),
          usdAmount: normalizedDesired.usdAmount == null ? null : Number(normalizedDesired.usdAmount),
        },
        deletedDuplicateIds: [],
        locked: false,
      };
    }

    const lockedRow = rows.find((r) => Number(r.locked || 0) === 1);
    const canonical = lockedRow || rows[0];
    const deletedDuplicateIds = [];

    for (const r of rows) {
      if (r.id === canonical.id) continue;
      if (Number(r.locked || 0) === 1) continue;
      deletedDuplicateIds.push(r.id);
      if (!dryRun) {
        deleteById.run(r.id);
      }
    }

    if (Number(canonical.locked || 0) === 1) {
      return {
        changeType: dryRun ? 'unchanged' : (deletedDuplicateIds.length ? 'updated' : 'unchanged'),
        recordId: canonical.id,
        previous: toRecordSnapshot(canonical),
        next: toRecordSnapshot(canonical),
        deletedDuplicateIds,
        locked: true,
      };
    }

    const compareTextMeta = normalizedDesired.transactionType !== 'INTEREST';

    const needsUpdate =
      !nearlyEqual(canonical.units, normalizedDesired.units) ||
      !nearlyEqual(canonical.price_per_unit, normalizedDesired.pricePerUnit) ||
      !nearlyEqual(canonical.amount, normalizedDesired.amount) ||
      (compareTextMeta && String(canonical.notes || '') !== String(normalizedDesired.notes || '')) ||
      (compareTextMeta && String(canonical.broker || '') !== String(normalizedDesired.broker || '')) ||
      !nearlyEqual(canonical.exchange_rate_used, normalizedDesired.fxRate) ||
      !nearlyEqual(canonical.usd_amount, normalizedDesired.usdAmount);

    if (needsUpdate && !dryRun) {
      updateById.run(
        normalizedDesired.units,
        normalizedDesired.pricePerUnit,
        normalizedDesired.amount,
        normalizedDesired.notes,
        normalizedDesired.broker,
        normalizedDesired.fxRate,
        normalizedDesired.usdAmount,
        canonical.id
      );
    }

    const changed = deletedDuplicateIds.length > 0 || needsUpdate;
    return {
      changeType: changed ? 'updated' : 'unchanged',
      recordId: canonical.id,
      previous: toRecordSnapshot(canonical),
      next: {
        units: Number(normalizedDesired.units == null ? 0 : normalizedDesired.units),
        pricePerUnit: Number(normalizedDesired.pricePerUnit == null ? 0 : normalizedDesired.pricePerUnit),
        amount: Number(normalizedDesired.amount == null ? 0 : normalizedDesired.amount),
        notes: normalizedDesired.notes || null,
        broker: normalizedDesired.broker || null,
        fxRate: normalizedDesired.fxRate == null ? null : Number(normalizedDesired.fxRate),
        usdAmount: normalizedDesired.usdAmount == null ? null : Number(normalizedDesired.usdAmount),
      },
      deletedDuplicateIds,
      locked: false,
    };
  }

  let inserted = 0;
  let updated = 0;
  let earliestChangedDate = null;
  const caChanges = [];

  const markChangedDate = (date) => {
    if (!date) return;
    if (!earliestChangedDate || date < earliestChangedDate) {
      earliestChangedDate = date;
    }
  };

  if (isCouponAsset) {
    const FREQUENCY_MONTHS = {
      MONTHLY: 1,
      QUARTERLY: 3,
      SEMI_ANNUAL: 6,
      ANNUAL: 12,
    };

    const normalizeFrequency = (value) => {
      const normalized = String(value || '').trim().toUpperCase();
      return FREQUENCY_MONTHS[normalized] ? normalized : null;
    };

    const addMonthsIso = (isoDate, months) => {
      const d = new Date(`${isoDate}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return null;
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
      const endOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, endOfMonth));
      return d.toISOString().slice(0, 10);
    };

    const addDaysIso = (isoDate, days) => {
      const d = new Date(`${isoDate}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return null;
      d.setUTCDate(d.getUTCDate() + Number(days || 0));
      return d.toISOString().slice(0, 10);
    };

    const formatDdMm = (isoDate) => {
      if (!isoDate) return null;
      const [year, month, day] = String(isoDate).split('-');
      if (!year || !month || !day) return null;
      return `${day}/${month}`;
    };

    const formatNumber = (value, decimals = 2) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      return n.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    };

    const buildCouponInterestNote = ({
      scheduleDate,
      periodMonths,
      units,
      amount,
      couponFrequency,
      periodDays,
      impliedDailyPerUnitFromHistory,
      perUnitFromHistory,
      annualCouponRate,
      principalPerUnit,
    }) => {
      const frequencyLabel = String(couponFrequency || '').replace(/_/g, ' ');
      const previousCouponDate = scheduleDate && periodMonths ? addMonthsIso(scheduleDate, -periodMonths) : null;
      const periodStart = previousCouponDate ? addDaysIso(previousCouponDate, 1) : null;
      const periodEnd = scheduleDate || null;

      let dayPart = `${frequencyLabel} coupon period`;
      if (periodStart && periodEnd) {
        const startTs = new Date(`${periodStart}T00:00:00.000Z`).getTime();
        const endTs = new Date(`${periodEnd}T00:00:00.000Z`).getTime();
        const daySpan = Math.round((endTs - startTs) / 86400000) + 1;
        const startLabel = formatDdMm(periodStart);
        const endLabel = formatDdMm(periodEnd);
        if (Number.isFinite(daySpan) && daySpan > 0 && startLabel && endLabel) {
          dayPart = `${daySpan} days (${startLabel}-${endLabel})`;
        }
      }

      if (impliedDailyPerUnitFromHistory && impliedDailyPerUnitFromHistory > 0 && Number.isFinite(periodDays) && periodDays > 0) {
        return `Gross interest: ${dayPart}; ${formatNumber(units, 3)} units x INR ${formatNumber(impliedDailyPerUnitFromHistory, 6)}/unit/day x ${formatNumber(periodDays, 0)} days = INR ${formatNumber(amount, 2)} (${frequencyLabel}, history-based)`;
      }

      if (perUnitFromHistory && perUnitFromHistory > 0) {
        return `Gross interest: ${dayPart}; ${formatNumber(units, 3)} units x INR ${formatNumber(perUnitFromHistory, 4)}/unit = INR ${formatNumber(amount, 2)} (${frequencyLabel}, history-based)`;
      }

      if (annualCouponRate > 0 && principalPerUnit > 0 && Number.isFinite(periodDays) && periodDays > 0) {
        return `Gross interest: ${dayPart}; ${formatNumber(units, 3)} units x INR ${formatNumber(principalPerUnit, 2)} x ${formatNumber(annualCouponRate, 4)}% x ${formatNumber(periodDays, 0)}/365 = INR ${formatNumber(amount, 2)} (${frequencyLabel})`;
      }

      if (annualCouponRate > 0 && principalPerUnit > 0 && periodMonths > 0) {
        const periodsPerYear = Math.round(12 / periodMonths);
        return `Gross interest: ${dayPart}; ${formatNumber(units, 3)} units x INR ${formatNumber(principalPerUnit, 2)} x ${formatNumber(annualCouponRate, 4)}% x 1/${periodsPerYear} = INR ${formatNumber(amount, 2)} (${frequencyLabel}, fallback)`;
      }

      return `Gross interest: ${dayPart}; expected coupon amount INR ${formatNumber(amount, 2)} (${frequencyLabel})`;
    };

    const parseRateFromText = (value) => {
      const text = String(value || '');
      const m = text.match(/(\d{1,2}(?:\.\d{1,4})?)\s*%/);
      if (!m) return 0;
      const rate = Number(m[1]);
      return Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : 0;
    };

    const median = (values = []) => {
      const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[mid];
      return (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const inferFrequencyFromInterestDates = (dates = []) => {
      if (dates.length < 2) return null;
      const diffs = [];
      for (let i = 1; i < dates.length; i += 1) {
        const prev = new Date(`${dates[i - 1]}T00:00:00.000Z`).getTime();
        const next = new Date(`${dates[i]}T00:00:00.000Z`).getTime();
        const days = Math.round((next - prev) / 86400000);
        if (Number.isFinite(days) && days > 0) diffs.push(days);
      }
      if (!diffs.length) return null;
      const avg = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      if (avg <= 45) return 'MONTHLY';
      if (avg <= 120) return 'QUARTERLY';
      if (avg <= 220) return 'SEMI_ANNUAL';
      return 'ANNUAL';
    };

    const interestRows = db.prepare(`
      SELECT date(transaction_date) AS tx_date, amount
      FROM transactions
      WHERE investment_id = ?
        AND portfolio_id = ?
        AND transaction_type = 'INTEREST'
        AND date(transaction_date) <= ?
      ORDER BY date(transaction_date) ASC, id ASC
    `).all(inv.id, portfolioId, toDate);

    const interestDates = interestRows.map((r) => String(r.tx_date || '')).filter(Boolean);
    const inferredFrequency = inferFrequencyFromInterestDates(interestDates);
    const couponFrequency = normalizeFrequency(inv.coupon_frequency) || inferredFrequency || 'SEMI_ANNUAL';
    const periodMonths = FREQUENCY_MONTHS[couponFrequency];

    const annualCouponRate = (() => {
      const explicitRate = Number(inv.coupon_rate || 0);
      if (Number.isFinite(explicitRate) && explicitRate > 0) return explicitRate;
      const fromName = parseRateFromText(inv.name);
      if (fromName > 0) return fromName;
      return parseRateFromText(inv.notes);
    })();

    const perUnitFromHistory = (() => {
      const vals = [];
      for (const row of interestRows) {
        const amount = Number(row?.amount || 0);
        const date = String(row?.tx_date || '');
        if (!(amount > 0) || !date) continue;
        const units = Number(holdingUnitsAtDateFast(date, false, false) || 0);
        if (!(units > 0)) continue;
        vals.push(amount / units);
      }
      return median(vals);
    })();

    const impliedDailyPerUnitFromHistory = (() => {
      const dailyVals = [];
      for (let i = 1; i < interestRows.length; i += 1) {
        const current = interestRows[i];
        const previous = interestRows[i - 1];
        const currentDate = String(current?.tx_date || '');
        const previousDate = String(previous?.tx_date || '');
        const amount = Number(current?.amount || 0);
        if (!currentDate || !previousDate || !(amount > 0)) continue;

        const observedDays = diffIsoDays(currentDate, previousDate);
        if (!(Number.isFinite(observedDays) && observedDays > 0)) continue;

        const units = Number(holdingUnitsAtDateFast(currentDate, false, false) || 0);
        if (!(units > 0)) continue;

        dailyVals.push((amount / units) / observedDays);
      }
      return median(dailyVals);
    })();

    const principalPerUnit = (() => {
      const face = Number(inv.face_value || 0);
      if (face > 0) return face;
      const buyPrices = holdingRows
        .filter((r) => String(r.transaction_type || '').toUpperCase() === 'BUY')
        .map((r) => Number(r.units > 0 ? (db.prepare(
          `SELECT price_per_unit FROM transactions
           WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) = ?
             AND UPPER(transaction_type) = 'BUY'
           ORDER BY id ASC LIMIT 1`
        ).get(inv.id, portfolioId, r.transaction_date)?.price_per_unit || 0) : 0))
        .filter((v) => Number.isFinite(v) && v > 0);
      return median(buyPrices) || 0;
    })();

    const useDayAwareCouponAmount = inv.asset_type === 'BOND';

    const firstScheduleDate = interestDates[0] || dayKeys[0] || null;
    if (!firstScheduleDate || !periodMonths) {
      return { inserted, updated, modified: inserted + updated, earliestChangedDate, caChanges };
    }

    let scheduleCursor = firstScheduleDate;
    if (!interestDates.length) {
      scheduleCursor = addMonthsIso(firstScheduleDate, periodMonths);
    }

    let guard = 0;
    while (scheduleCursor && scheduleCursor <= toDate && guard < 500) {
      guard += 1;

      if (scheduleCursor >= fromDate) {
        const units = Number(holdingUnitsAtDateFast(scheduleCursor, false, false) || 0);
        if (units > 0) {
          let amount = 0;
          const previousCouponDate = addMonthsIso(scheduleCursor, -periodMonths);
          const periodStart = previousCouponDate ? addDaysIso(previousCouponDate, 1) : null;
          const periodDays = periodStart ? (diffIsoDays(scheduleCursor, periodStart) + 1) : null;

          if (useDayAwareCouponAmount && impliedDailyPerUnitFromHistory && impliedDailyPerUnitFromHistory > 0 && Number.isFinite(periodDays) && periodDays > 0) {
            amount = units * impliedDailyPerUnitFromHistory * periodDays;
          } else if (useDayAwareCouponAmount && annualCouponRate > 0 && principalPerUnit > 0 && Number.isFinite(periodDays) && periodDays > 0) {
            amount = units * principalPerUnit * (annualCouponRate / 100) * (periodDays / 365);
          } else if (perUnitFromHistory && perUnitFromHistory > 0) {
            amount = units * perUnitFromHistory;
          } else if (annualCouponRate > 0 && principalPerUnit > 0) {
            amount = units * principalPerUnit * (annualCouponRate / 100) * (periodMonths / 12);
          }

          if (amount > 0) {
            amount = Math.round(amount * 100) / 100;
            const notes = buildCouponInterestNote({
              scheduleDate: scheduleCursor,
              periodMonths,
              units,
              amount,
              couponFrequency,
              periodDays: useDayAwareCouponAmount ? periodDays : null,
              impliedDailyPerUnitFromHistory: useDayAwareCouponAmount ? impliedDailyPerUnitFromHistory : null,
              perUnitFromHistory,
              annualCouponRate,
              principalPerUnit,
            });
            const change = upsertCorporateActionTxn({
              investmentId: inv.id,
              portfolioId,
              transactionType: 'INTEREST',
              date: scheduleCursor,
              units: null,
              pricePerUnit: null,
              amount,
              notes,
              broker: null,
              fxRate: null,
              usdAmount: null,
            });
            const changeType = change?.changeType || 'unchanged';
            if (changeType !== 'unchanged') {
              if (changeType === 'inserted') inserted += 1;
              else updated += 1;
              markChangedDate(scheduleCursor);
              caChanges.push({
                action: changeType,
                recordId: change.recordId,
                investmentId: inv.id,
                investmentName: inv.name,
                portfolioId,
                transactionType: 'INTEREST',
                transactionDate: scheduleCursor,
                previous: change.previous,
                next: change.next,
                deletedDuplicateIds: change.deletedDuplicateIds || [],
                locked: !!change.locked,
              });
            }
          }
        }
      }

      scheduleCursor = addMonthsIso(scheduleCursor, periodMonths);
    }

    return {
      inserted,
      updated,
      modified: inserted + updated,
      earliestChangedDate,
      caChanges,
    };
  }

  const dividendCacheKey = `${inv.id}:${fromDate}:${toDate}`;
  let dividends = cache.dividendEvents.get(dividendCacheKey);
  if (!dividends) {
    let dividendPromise = cache.dividendPromises.get(dividendCacheKey);
    if (!dividendPromise) {
      dividendPromise = fetchDividendEventsForRange(ticker, fromDate, toDate, { assetType: inv.asset_type }).catch((error) => {
        logBackfillWarn('[Backfill][CA] Dividend fetch failed for range window', {
          investmentId: inv.id,
          investmentName: inv.name,
          portfolioId,
          ticker,
          fromDate,
          toDate,
          error: error?.message || String(error),
        });
        return { dividends: [], warnings: [] };
      });
      cache.dividendPromises.set(dividendCacheKey, dividendPromise);
    }
    const dividendResult = await dividendPromise;
    dividends = Array.isArray(dividendResult?.dividends) ? dividendResult.dividends : [];
    const dividendWarnings = Array.isArray(dividendResult?.warnings) ? dividendResult.warnings : [];
    for (const warning of dividendWarnings) {
      logBackfillWarn('[Backfill][CA] Dividend provider warning', {
        investmentId: inv.id,
        investmentName: inv.name,
        portfolioId,
        ticker,
        fromDate,
        toDate,
        warning,
      });
    }
    cache.dividendEvents.set(dividendCacheKey, dividends);
    cache.dividendPromises.delete(dividendCacheKey);
  }

  const splitEventsAll = loadLocalSplitEventsForInvestment(db, inv.id, cache);
  const splitEvents = splitEventsAll.filter((event) => event.date >= fromDate && event.date <= toDate);

  for (const div of dividends || []) {
    const eventDate = inv.asset_type === 'FOREIGN_STOCK'
      ? (div.payment_date || div.date)
      : div.date;
    const recordDate = inv.asset_type === 'FOREIGN_STOCK'
      ? (div.record_date || div.date)
      : div.date;

    if (!eventDate || eventDate < fromDate || eventDate > toDate) continue;
    // Dividend entitlement calculated on previous day's holding (record date - 1)
    const prevDay = new Date(recordDate || eventDate);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().split('T')[0];
    const units = holdingUnitsAtDateFast(prevDayStr, true, true);
    if (units <= 0) continue;

    const basePerShare = Number(div.amount || 0);
    if (!(basePerShare > 0)) continue;
    const splitAdjustFactor = inv.asset_type === 'FOREIGN_STOCK'
      ? 1
      : getSplitAdjustmentFactorForDividend(splitEventsAll, eventDate);
    const perShare = basePerShare * splitAdjustFactor;

    let fxRate = null;
    let usdAmount = null;
    let amount = units * perShare;
    if (inv.asset_type === 'FOREIGN_STOCK') {
      usdAmount = amount;
      // In-memory FX map is a DB-hydrated fast-path; fallback to DB cache when missing.
      fxRate = cache.fx.get(eventDate);
      if (!(fxRate != null && Number.isFinite(Number(fxRate)) && Number(fxRate) > 0)) {
        fxRate = getLocalFxRateOnOrBefore(eventDate);
      }
      if (!(fxRate != null && Number.isFinite(Number(fxRate)) && Number(fxRate) > 0)) {
        fxRate = await fetchHistoricalUSDToINR(eventDate).catch((err) => {
          logBackfillError(`[Backfill][FX] USDINR history fetch failed for dividend date ${eventDate}: ${err?.message || err}`);
          return 0;
        });
      }
      cache.fx.set(eventDate, Number(fxRate || 0));
      if (!(fxRate > 0)) continue;
      amount = usdAmount * Number(fxRate);
    }

    const notes = `AutoBackfill CA Dividend ${perShare} x ${units}`;
    const change = upsertCorporateActionTxn({
      investmentId: inv.id,
      portfolioId,
      transactionType: 'DIVIDEND',
      date: eventDate,
      units,
      pricePerUnit: perShare,
      amount,
      notes,
      broker: null,
      fxRate: fxRate ? Number(fxRate) : null,
      usdAmount,
    });
    const changeType = change?.changeType || 'unchanged';
    if (changeType !== 'unchanged') {
      if (changeType === 'inserted') inserted += 1;
      else updated += 1;
      markChangedDate(eventDate);
      caChanges.push({
        action: changeType,
        recordId: change.recordId,
        investmentId: inv.id,
        investmentName: inv.name,
        portfolioId,
        transactionType: 'DIVIDEND',
        transactionDate: eventDate,
        previous: change.previous,
        next: change.next,
        deletedDuplicateIds: change.deletedDuplicateIds || [],
        locked: !!change.locked,
      });
    }
  }

  for (const split of splitEvents || []) {
    const eventDate = split.date;
    if (!eventDate || eventDate < fromDate || eventDate > toDate) continue;

    const ratio = Number(split.ratio || 0);
    if (!(ratio > 1)) continue;

    // Split/bonus entitlement is based on previous day's holdings.
    const prevDay = new Date(eventDate);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().split('T')[0];
    const held = holdingUnitsAtDateFast(prevDayStr, true, true);
    if (held <= 0) continue;

    const cleanSplit = Number.isInteger(ratio) && ratio >= 2;
    const txnType = cleanSplit ? 'SPLIT' : 'BONUS';
    const addedUnitsRaw = held * (ratio - 1);
    const isIndianStock = inv.asset_type === 'INDIAN_STOCK';
    const addedUnits = isIndianStock
      ? Math.max(0, Math.floor(addedUnitsRaw + 0.000000001))
      : addedUnitsRaw;
    if (addedUnits <= 0) continue;

    // For Indian stocks, bonus/split grants are whole shares and residue is cash payout.
    const fractional = isIndianStock
      ? Math.max(0, addedUnitsRaw - addedUnits)
      : (txnType === 'BONUS' ? Math.max(0, addedUnitsRaw - addedUnits) : 0);
    let fractionalAmount = 0;
    if (fractional > 0.0001) {
      // Use previous day's LOW price for fractional payout calculation
      const prevDay = new Date(eventDate);
      prevDay.setDate(prevDay.getDate() - 1);
      const prevDayStr = prevDay.toISOString().split('T')[0];
      const ohlcCacheKey = `${ticker}:${prevDayStr}`;
      let ohlc = cache.ohlc.get(ohlcCacheKey);
      if (!ohlc) {
        ohlc = await fetchHistoricalOHLC(ticker, prevDayStr).catch((err) => {
          logBackfillError(`[Backfill][OHLC] Failed to fetch OHLC for ${ticker} on ${prevDayStr}: ${err?.message || err}`);
          return null;
        });
        cache.ohlc.set(ohlcCacheKey, ohlc || null);
      }
      const lowPrice = ohlc?.low || 0;
      fractionalAmount = lowPrice > 0 ? (fractional * lowPrice) : 0;
    }

    const ratioLabel = formatCorporateActionRatioLabel(ratio);
    const notes = fractional > 0.0001
      ? `AutoBackfill CA ${txnType} ${ratioLabel} + \u20B9${fractionalAmount} fractional payout`
      : `AutoBackfill CA ${txnType} ${ratioLabel}`;
    const change = upsertCorporateActionTxn({
      investmentId: inv.id,
      portfolioId,
      transactionType: txnType,
      date: eventDate,
      units: addedUnits,
      pricePerUnit: 0,
      amount: fractionalAmount,
      notes,
      broker: null,
      fxRate: null,
      usdAmount: null,
    });
    const changeType = change?.changeType || 'unchanged';
    if (changeType !== 'unchanged') {
      if (changeType === 'inserted') inserted += 1;
      else updated += 1;
      markChangedDate(eventDate);
      caChanges.push({
        action: changeType,
        recordId: change.recordId,
        investmentId: inv.id,
        investmentName: inv.name,
        portfolioId,
        transactionType: txnType,
        transactionDate: eventDate,
        previous: change.previous,
        next: change.next,
        deletedDuplicateIds: change.deletedDuplicateIds || [],
        locked: !!change.locked,
      });
    }
  }

  return {
    inserted,
    updated,
    modified: inserted + updated,
    earliestChangedDate,
    caChanges,
  };
}

function normalizeScopesForRun(db, scopes, runDate) {
  const eligible = (scopes || []).filter((s) => String(s.dirty_from_date) <= runDate);
  const grouped = new Map();
  const portfolioIdsByInvestment = new Map();

  const addScope = (investmentId, portfolioId, dirtyFromDate, dirtyReason = null, sourceEventId = null) => {
    const invId = investmentId == null ? 'null' : String(investmentId);
    const pid = String(portfolioId);
    const key = `${invId}:${pid}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        investment_id: investmentId,
        portfolio_id: portfolioId,
        dirty_from_date: dirtyFromDate,
        requested_dirty_from_date: dirtyFromDate,
        dirty_reason: dirtyReason || null,
        source_event_id: sourceEventId || null,
        replay_intent: classifyHistoricalReplayIntent(dirtyReason, sourceEventId),
        backward_expansion: null,
      });
      return;
    }

    if (dirtyFromDate < existing.dirty_from_date) {
      existing.dirty_from_date = dirtyFromDate;
    }
    if (dirtyFromDate < existing.requested_dirty_from_date) {
      existing.requested_dirty_from_date = dirtyFromDate;
    }
    existing.dirty_reason = mergeDelimitedValues(existing.dirty_reason, dirtyReason);
    existing.source_event_id = mergeDelimitedValues(existing.source_event_id, sourceEventId);
    existing.replay_intent = classifyHistoricalReplayIntent(existing.dirty_reason, existing.source_event_id);
  };

  for (const s of eligible) {
    if (s.investment_id == null) continue;

    if (s.portfolio_id != null) {
      addScope(s.investment_id, s.portfolio_id, s.dirty_from_date, s.dirty_reason, s.source_event_id);
      continue;
    }

    // Legacy/global scopes can still be present (for example scheduler catch-up).
    // Expand them to concrete transaction portfolios so recompute is not skipped.
    if (!portfolioIdsByInvestment.has(s.investment_id)) {
      const portfolioRows = db.prepare(`
        SELECT DISTINCT portfolio_id
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id IS NOT NULL
          AND date(transaction_date) <= ?
      `).all(s.investment_id, runDate);
      portfolioIdsByInvestment.set(
        s.investment_id,
        portfolioRows
          .map((row) => row.portfolio_id)
          .filter((pid) => pid != null)
      );
    }

    const portfolioIds = portfolioIdsByInvestment.get(s.investment_id) || [];
    for (const pid of portfolioIds) {
      addScope(s.investment_id, pid, s.dirty_from_date, s.dirty_reason, s.source_event_id);
    }
  }

  return {
    eligible,
    scopeList: Array.from(grouped.values()).filter((s) => s.investment_id != null),
  };
}

function buildGeneralizedStep1Scopes(db, scopeList, runDate) {
  const mergedByInvestment = new Map();

  const mergeScope = (investmentId, dirtyFromDate, seed = null) => {
    if (investmentId == null || !dirtyFromDate) return;
    const existing = mergedByInvestment.get(investmentId);
    if (!existing) {
      mergedByInvestment.set(investmentId, {
        investment_id: investmentId,
        portfolio_id: null,
        dirty_from_date: dirtyFromDate,
        requested_dirty_from_date: dirtyFromDate,
        dirty_reason: seed?.dirty_reason || seed?.dirtyReason || null,
        source_event_id: seed?.source_event_id || seed?.sourceEventId || null,
        replay_intent: classifyHistoricalReplayIntent(seed?.dirty_reason || seed?.dirtyReason || null, seed?.source_event_id || seed?.sourceEventId || null),
        backward_expansion: null,
      });
      return;
    }

    if (dirtyFromDate < existing.dirty_from_date) {
      existing.dirty_from_date = dirtyFromDate;
    }
    if (dirtyFromDate < existing.requested_dirty_from_date) {
      existing.requested_dirty_from_date = dirtyFromDate;
    }
    existing.dirty_reason = mergeDelimitedValues(existing.dirty_reason, seed?.dirty_reason || seed?.dirtyReason || null);
    existing.source_event_id = mergeDelimitedValues(existing.source_event_id, seed?.source_event_id || seed?.sourceEventId || null);
    existing.replay_intent = classifyHistoricalReplayIntent(existing.dirty_reason, existing.source_event_id);
  };

  for (const scope of scopeList || []) {
    if (scope?.investment_id == null || !scope?.dirty_from_date) continue;
    mergeScope(scope.investment_id, scope.dirty_from_date, scope);
  }

  const activeRows = db.prepare(`
    SELECT
      i.id AS investment_id,
      MIN(date(t.transaction_date)) AS min_txn_date,
      COALESCE(SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE date(t.transaction_date) <= ?
      AND i.asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB', 'MUTUAL_FUND', 'NPS')
      AND COALESCE(i.is_active, 1) = 1
      AND COALESCE(i.exclude_from_tracking, 0) != 1
    GROUP BY i.id
    HAVING net_units > ?
  `).all(runDate, EXITED_UNITS_EPSILON);

  for (const row of activeRows) {
    const minTxnDate = toIsoDate(row?.min_txn_date);
    if (!minTxnDate) continue;
    mergeScope(Number(row.investment_id), minTxnDate, {
      dirtyReason: 'step1-generalized-active-holding',
      sourceEventId: `backfill-step1-generalized:${runDate}`,
    });
  }

  return Array.from(mergedByInvestment.values());
}

function mergeDirtyDateIntoScopes(scopeList, investmentId, portfolioId, dirtyFromDate, metadata = null) {
  if (!dirtyFromDate || investmentId == null) return;
  let matched = false;

  for (const s of scopeList) {
    if (s.investment_id !== investmentId) continue;
    const samePortfolio = (s.portfolio_id == null && portfolioId == null) || s.portfolio_id === portfolioId;
    if (!samePortfolio) continue;
    if (dirtyFromDate < s.dirty_from_date) {
      s.backward_expansion = {
        requested_dirty_from_date: s.requested_dirty_from_date || s.dirty_from_date,
        effective_dirty_from_date: dirtyFromDate,
        cause: mergeDelimitedValues(s.backward_expansion?.cause || null, metadata?.cause || null),
      };
      s.dirty_from_date = dirtyFromDate;
    }
    matched = true;
  }

  if (!matched) {
    scopeList.push({
      investment_id: investmentId,
      portfolio_id: portfolioId,
      dirty_from_date: dirtyFromDate,
      requested_dirty_from_date: dirtyFromDate,
      dirty_reason: metadata?.dirtyReason || null,
      source_event_id: metadata?.sourceEventId || null,
      replay_intent: classifyHistoricalReplayIntent(metadata?.dirtyReason || null, metadata?.sourceEventId || null),
      backward_expansion: null,
    });
  }

  if (portfolioId != null) {
    mergeDirtyDateIntoScopes(scopeList, investmentId, null, dirtyFromDate, metadata);
  }
}

function getImpactedInvestmentStartDates(db, scopeList, runDate) {
  const invIds = Array.from(new Set(scopeList.map((s) => s.investment_id).filter((id) => id != null)));
  const startByInvestment = new Map();
  if (!invIds.length) return startByInvestment;

  const placeholders = invIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT investment_id, MIN(date(transaction_date)) AS min_txn_date
    FROM transactions
    WHERE investment_id IN (${placeholders})
    GROUP BY investment_id
  `).all(...invIds);

  const minScopeDateByInvestment = new Map();
  for (const s of scopeList) {
    const current = minScopeDateByInvestment.get(s.investment_id);
    if (!current || s.dirty_from_date < current) {
      minScopeDateByInvestment.set(s.investment_id, s.dirty_from_date);
    }
  }

  for (const invId of invIds) {
    const row = rows.find((r) => r.investment_id === invId);
    const minTxnDate = row?.min_txn_date || null;
    const minDirtyDate = minScopeDateByInvestment.get(invId) || null;

    const txnStart = minTxnDate || null;
    const dirtyStart = minDirtyDate || null;

    // Reuse prior backfill windows by preferring the later start date.
    // start = max(earliest_txn_date, least_dirty_date) with safe fallbacks.
    let startDate = null;
    if (txnStart && dirtyStart) {
      startDate = txnStart >= dirtyStart ? txnStart : dirtyStart;
    } else {
      startDate = txnStart || dirtyStart || runDate;
    }

    startByInvestment.set(invId, startDate);
  }

  return startByInvestment;
}

function getMarketHistoryFetchStartDates(db, scopeList, invMap, runDate) {
  const marketInvIds = Array.from(new Set(
    scopeList
      .map((s) => s.investment_id)
      .filter((id) => {
        const inv = invMap.get(id);
        return inv && ['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type);
      })
  ));

  const startByInvestment = new Map();
  if (!marketInvIds.length) return startByInvestment;

  const placeholders = marketInvIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT investment_id, MIN(date(transaction_date)) AS min_txn_date
    FROM transactions
    WHERE investment_id IN (${placeholders})
    GROUP BY investment_id
  `).all(...marketInvIds);

  const minScopeDateByInvestment = new Map();
  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv || !['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type)) continue;
    const current = minScopeDateByInvestment.get(s.investment_id);
    if (!current || s.dirty_from_date < current) {
      minScopeDateByInvestment.set(s.investment_id, s.dirty_from_date);
    }
  }

  for (const invId of marketInvIds) {
    const row = rows.find((r) => r.investment_id === invId);
    const minTxnDate = row?.min_txn_date || null;
    const minDirtyDate = minScopeDateByInvestment.get(invId) || null;

    const txnStart = minTxnDate || null;
    const dirtyStart = minDirtyDate || null;

    let startDate = null;
    if (txnStart && dirtyStart) {
      startDate = txnStart >= dirtyStart ? txnStart : dirtyStart;
    } else {
      startDate = txnStart || dirtyStart || runDate;
    }

    startByInvestment.set(invId, startDate);
  }

  return startByInvestment;
}

function getMarketHistoryFetchEndDates(db, scopeList, invMap, runDate) {
  const stockInvIds = Array.from(new Set(
    scopeList
      .map((s) => s.investment_id)
      .filter((id) => {
        const inv = invMap.get(id);
        return inv && ['INDIAN_STOCK', 'FOREIGN_STOCK'].includes(inv.asset_type);
      })
  ));

  const endByInvestment = new Map();
  if (!stockInvIds.length) return endByInvestment;
  const marketCacheEndDate = getMarketCacheEvaluationEndDate(runDate);
  const providerReadyEndDate = getProviderReadyEndDate(marketCacheEndDate, db);

  const placeholders = stockInvIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      investment_id,
      MAX(date(transaction_date)) AS max_txn_date,
      COALESCE(SUM(
        CASE
          WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
          WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM transactions
    WHERE investment_id IN (${placeholders})
      AND date(transaction_date) <= ?
    GROUP BY investment_id
  `).all(...stockInvIds, marketCacheEndDate);

  for (const invId of stockInvIds) {
    const row = rows.find((r) => r.investment_id === invId);
    const maxTxnDate = toIsoDate(row?.max_txn_date) || null;
    const netUnits = Number(row?.net_units || 0);
    const isExited = Math.abs(netUnits) <= EXITED_UNITS_EPSILON;
    const cappedEnd = (isExited && maxTxnDate)
      ? (maxTxnDate < providerReadyEndDate ? maxTxnDate : providerReadyEndDate)
      : providerReadyEndDate;
    endByInvestment.set(invId, cappedEnd);
  }

  return endByInvestment;
}

function getHoldingsCappedFetchEndDates(db, scopeList, invMap, runDate, assetTypes = []) {
  const typeSet = new Set((Array.isArray(assetTypes) ? assetTypes : []).map((t) => String(t || '')));
  const invIds = Array.from(new Set(
    scopeList
      .map((s) => s.investment_id)
      .filter((id) => {
        const inv = invMap.get(id);
        return inv && typeSet.has(inv.asset_type);
      })
  ));

  const endByInvestment = new Map();
  if (!invIds.length) return endByInvestment;
  const marketCacheEndDate = getMarketCacheEvaluationEndDate(runDate);

  const placeholders = invIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      investment_id,
      MAX(date(transaction_date)) AS max_txn_date,
      COALESCE(SUM(
        CASE
          WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
          WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM transactions
    WHERE investment_id IN (${placeholders})
      AND date(transaction_date) <= ?
    GROUP BY investment_id
  `).all(...invIds, marketCacheEndDate);

  for (const invId of invIds) {
    const row = rows.find((r) => r.investment_id === invId);
    const maxTxnDate = toIsoDate(row?.max_txn_date) || null;
    const netUnits = Number(row?.net_units || 0);
    const isExited = Math.abs(netUnits) <= EXITED_UNITS_EPSILON;
    const cappedEnd = (isExited && maxTxnDate)
      ? (maxTxnDate < marketCacheEndDate ? maxTxnDate : marketCacheEndDate)
      : marketCacheEndDate;
    endByInvestment.set(invId, cappedEnd);
  }

  return endByInvestment;
}

function getForeignStockFxWindowsForRun(db, runDate) {
  const marketCacheEndDate = getMarketCacheEvaluationEndDate(runDate);
  const rows = db.prepare(`
    SELECT
      i.id AS investment_id,
      i.name,
      i.ticker_symbol,
      MIN(date(t.transaction_date)) AS min_txn_date,
      MAX(date(t.transaction_date)) AS max_txn_date,
      COALESCE(SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE i.asset_type = 'FOREIGN_STOCK'
      AND date(t.transaction_date) <= ?
    GROUP BY i.id, i.name, i.ticker_symbol
    ORDER BY i.id ASC
  `).all(marketCacheEndDate);

  const windows = [];
  const metaByInvestment = new Map();

  for (const row of rows) {
    const investmentId = Number(row?.investment_id);
    const startDate = toIsoDate(row?.min_txn_date) || null;
    const maxTxnDate = toIsoDate(row?.max_txn_date) || null;
    const netUnits = Number(row?.net_units || 0);
    const isExited = Math.abs(netUnits) <= EXITED_UNITS_EPSILON;
    const endDate = (isExited && maxTxnDate && maxTxnDate < marketCacheEndDate) ? maxTxnDate : marketCacheEndDate;

    if (!investmentId || !startDate || !endDate || startDate > endDate) continue;

    windows.push({
      investmentId,
      startDate,
      endDate,
      netUnits,
      isExited,
      maxTxnDate,
    });

    metaByInvestment.set(investmentId, {
      investmentName: row?.name || null,
      tickerSymbol: row?.ticker_symbol || null,
      netUnits,
      isExited,
      maxTxnDate,
    });
  }

  return { windows, metaByInvestment };
}

async function preloadStockHistoryForRun(db, invMap, scopeList, runDate, startByInvestment, fetchStartByInvestment, fetchEndByInvestment, cache) {
  const investmentSymbolWindows = [];
  const marketCacheEndDate = getMarketCacheEvaluationEndDate(runDate);
  const sgbEndByInvestment = getHoldingsCappedFetchEndDates(db, scopeList, invMap, runDate, ['SGB']);
  const sgbWindowByInvestment = new Map();
  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv) continue;
    if (!['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type)) continue;
    if (inv.asset_type !== 'SGB') continue;

    // For SGB, use full investment lifetime (startByInvestment) to find all gaps
    const startDate = startByInvestment.get(inv.id);
    const endDate = sgbEndByInvestment.get(inv.id) || marketCacheEndDate;

    const symbol = normalizeStockSymbol(inv.ticker_symbol, inv.asset_type);
    if (!symbol || !startDate || !endDate || startDate > endDate) continue;

    const existing = sgbWindowByInvestment.get(inv.id);
    if (!existing) {
      sgbWindowByInvestment.set(inv.id, { symbol, startDate, endDate });
      continue;
    }

    const mergedStart = startDate < existing.startDate ? startDate : existing.startDate;
    const mergedEnd = endDate > existing.endDate ? endDate : existing.endDate;
    sgbWindowByInvestment.set(inv.id, { symbol, startDate: mergedStart, endDate: mergedEnd });
  }

  const stockInvIds = Array.from(new Set(
    scopeList
      .map((s) => s.investment_id)
      .filter((id) => {
        const inv = invMap.get(id);
        return inv && ['INDIAN_STOCK', 'FOREIGN_STOCK'].includes(inv.asset_type);
      })
  ));

  cache.stockByInvestment = cache.stockByInvestment || new Map();
  for (const invId of stockInvIds) {
    const inv = invMap.get(invId);
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = fetchEndByInvestment.get(invId) || marketCacheEndDate;
    if (!inv || !startDate || !endDate || startDate > endDate) continue;

    const seriesRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    const seriesMap = new Map(seriesRows.map((row) => [row.date, Number(row.adj_close ?? row.close)]));
    cache.stockByInvestment.set(invId, seriesMap);

    const marketSessionDates = getMarketSessionDates(startDate, endDate, inv.asset_type);
    const missingSegments = getMissingMarketSessionSegments(seriesRows, marketSessionDates);
    if (!missingSegments.length) continue;

    const symbolWindows = buildMissingSymbolWindows(inv, missingSegments, cache);
    for (const window of symbolWindows) {
      investmentSymbolWindows.push({
        investmentId: inv.id,
        instrumentType: inferStockInstrumentType(window.symbol),
        symbol: window.symbol,
        startDate: window.startDate,
        endDate: window.endDate,
      });
    }
  }

  cache.stockRangeBySymbol = new Map();
  cache.stockRangeEndBySymbol = new Map();
  cache.sgbRangeBySymbol = new Map();
  const sgbWindows = Array.from(sgbWindowByInvestment.entries()).map(([investmentId, window]) => ({
    investmentId,
    ...window,
  }));

  for (const window of sgbWindows) {
    const existingStart = cache.sgbRangeBySymbol.get(window.symbol);
    if (!existingStart || window.startDate < existingStart) {
      cache.sgbRangeBySymbol.set(window.symbol, window.startDate);
    }
  }

  const totalSgbInvestments = sgbWindows.length;
  if (totalSgbInvestments > 0) {
    logBackfillInfo(`[Backfill][SGB] Prefetching historical prices for ${totalSgbInvestments} SGB investment(s)...`);
  }

  for (const window of sgbWindows) {
    const existingInvestmentRows = getInvestmentSeries(
      window.investmentId,
      window.startDate,
      window.endDate
    ).filter((row) => row?.close != null);
    const investmentSessions = getMarketSessionDates(window.startDate, window.endDate, 'SGB');

    if (!hasCompleteInvestmentCoverage(existingInvestmentRows, investmentSessions)) {
      const missingSegments = getMissingMarketSessionSegments(existingInvestmentRows, investmentSessions);
      const segmentWindows = missingSegments
        .filter((segment) => Array.isArray(segment) && segment.length > 0)
        .map((segment) => ({
          startDate: segment[0],
          endDate: segment[segment.length - 1],
        }));

      const sgbFetchWindows = [];
      if (segmentWindows.length > 0) {
        let mergedStart = segmentWindows[0].startDate;
        let mergedEnd = segmentWindows[0].endDate;
        for (let i = 1; i < segmentWindows.length; i += 1) {
          const current = segmentWindows[i];
          if (current.startDate < mergedStart) mergedStart = current.startDate;
          if (current.endDate > mergedEnd) mergedEnd = current.endDate;
        }
        sgbFetchWindows.push({ startDate: mergedStart, endDate: mergedEnd });
      }

      const { fetchSGBNseHistoricalRaw, buildNseHistoricalYearChunks } = require('./sgbNseHistorical');
      for (const fetchWindow of sgbFetchWindows) {
        logBackfillInfo(`[Backfill][SGB] [MarketCache] Missing cache for investment ${window.investmentId} from ${fetchWindow.startDate} to ${fetchWindow.endDate}`, {
          investmentId: window.investmentId,
          symbol: window.symbol,
          fromDate: fetchWindow.startDate,
          toDate: fetchWindow.endDate,
        });

        // Chunk merged span into yearly chunks for efficient provider calls
        const yearlyChunks = buildNseHistoricalYearChunks(fetchWindow.startDate, fetchWindow.endDate);

        for (const chunk of yearlyChunks) {
          // Check if this yearly chunk is already fully cached
          const cachedRows = getInvestmentSeries(
            window.investmentId,
            chunk.from,
            chunk.to
          ).filter((row) => row?.close != null);
          const chunkSessions = getMarketSessionDates(chunk.from, chunk.to, 'SGB');

          // Skip this chunk if already fully cached
          if (cachedRows.length >= chunkSessions.length) {
            continue;
          }

          // Fetch this yearly chunk
          const rows = await fetchSGBNseHistoricalRaw(window.symbol, chunk.from, chunk.to, (level, msg, meta) => {
            if (level === 'error') logBackfillError(`[SGB][FetchRaw] ${msg}`, meta);
            else if (level === 'warn') logBackfillWarn(`[SGB][FetchRaw] ${msg}`, meta);
            else logBackfillInfo(`[SGB][FetchRaw] ${msg}`, meta);
          }).catch((err) => {
            logBackfillError(`[Backfill][SGB] Prefetch failed for ${window.symbol}`, {
              investmentId: window.investmentId,
              symbol: window.symbol,
              fromDate: chunk.from,
              toDate: chunk.to,
              error: err?.message || String(err),
            });
            return [];
          });

          logBackfillInfo('[Backfill][SGB] Received chunk rows, expected sessions', {
            investmentId: window.investmentId,
            symbol: window.symbol,
            fromDate: chunk.from,
            toDate: chunk.to,
            receivedRows: rows.length,
            expectedSessions: chunkSessions.length,
          });

          if (rows.length > 0) {
            const points = rows.map((row) => ({
              date: row.date,
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
              adjClose: row.adj_close,
              volume: row.volume,
              source: row.source,
            }));
            upsertInvestmentPriceSeries(window.investmentId, 'SGB', window.symbol, points, null);
          }

          logBackfillInfo(`[Backfill][SGB] [MarketCache] Fetched ${rows.length} points for investment ${window.investmentId} from ${chunk.from} to ${chunk.to}`, {
            investmentId: window.investmentId,
            symbol: window.symbol,
            fromDate: chunk.from,
            toDate: chunk.to,
            fetchedPoints: rows.length,
          });
        }
      }
    }

    const localMap = loadSeriesMapFromLocalCache('SGB', window.symbol, window.startDate, window.endDate, (row) => row.close);
    const existingMap = cache.sgb.get(window.symbol) || new Map();
    for (const [d, v] of localMap.entries()) existingMap.set(d, v);

    backfillPreProviderIpoSessions({
      investmentId: window.investmentId,
      instrumentType: 'SGB',
      symbol: window.symbol,
      fillStartDate: window.startDate,
      fillEndDate: window.endDate,
      seriesMap: existingMap,
    });

    cache.sgb.set(window.symbol, existingMap);
  }

  if (totalSgbInvestments > 0) {
    logBackfillInfo('[Backfill][SGB] Completed.', { investments: totalSgbInvestments });
  }

  if (stockInvIds.length > 0) {
    logBackfillInfo('[Backfill][Stocks] Starting prewarm...', { investments: stockInvIds.length });
  }

  const mergedInvestmentSymbolWindows = [];
  const mergedWindowByKey = new Map();
  for (const window of investmentSymbolWindows) {
    const key = `${window.investmentId}|${window.instrumentType}|${window.symbol}`;
    const existing = mergedWindowByKey.get(key);
    if (!existing) {
      const merged = { ...window };
      mergedWindowByKey.set(key, merged);
      mergedInvestmentSymbolWindows.push(merged);
      continue;
    }

    if (window.startDate < existing.startDate) existing.startDate = window.startDate;
    if (window.endDate > existing.endDate) existing.endDate = window.endDate;
  }

  for (const window of mergedInvestmentSymbolWindows) {
    const rows = await hydrateStockSeriesForPhase2({
      investmentId: window.investmentId,
      instrumentType: window.instrumentType,
      symbol: window.symbol,
      fromDate: window.startDate,
      toDate: window.endDate,
      freshnessSkipFromDate: runDate,
      sourceLabel: 'YAHOO',
      fetchRange: async (missingFrom, missingTo) => fetchStockSeriesFromSource(window.symbol, missingFrom, missingTo),
      mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
      onWarn: (message, meta) => logBackfillWarn(`[Backfill][Stocks] ${message}`, meta),
      onInfo: (message, meta) => logBackfillInfo(`[Backfill][Stocks] ${message}`, meta),
    }).catch((err) => {
      logBackfillError(`[Backfill][Stocks] Hydration failed for ${window.symbol}: ${err?.message || err}`);
      return [];
    });
    if (!rows.length) continue;
    const points = rows.map((row) => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      adjClose: row.adj_close,
      volume: row.volume,
      source: row.source,
    }));
    upsertInvestmentPriceSeries(window.investmentId, window.instrumentType, window.symbol, points, null);
  }

  for (const invId of stockInvIds) {
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = fetchEndByInvestment.get(invId) || runDate;
    if (!startDate || !endDate || startDate > endDate) continue;

    const seriesRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    const seriesMap = new Map(seriesRows.map((row) => [row.date, Number(row.adj_close ?? row.close)]));
    cache.stockByInvestment.set(invId, seriesMap);
  }

  const firstUnitInflowByInvestment = new Map();
  if (stockInvIds.length) {
    const txStmt = db.prepare(`
      SELECT date(transaction_date) AS tx_date, UPPER(transaction_type) AS tx_type, COALESCE(units, 0) AS units
      FROM transactions
      WHERE investment_id = ?
        AND date(transaction_date) <= ?
      ORDER BY date(transaction_date) ASC, id ASC
    `);

    for (const invId of stockInvIds) {
      const txRows = txStmt.all(invId, runDate);
      const firstUnitInflow = txRows.find((tx) => Number(tx.units || 0) > 0);
      if (!firstUnitInflow) continue;
      firstUnitInflowByInvestment.set(invId, {
        date: String(firstUnitInflow.tx_date || ''),
        transactionType: String(firstUnitInflow.tx_type || ''),
      });
    }
  }

  for (const invId of stockInvIds) {
    const inv = invMap.get(invId);
    if (!inv || inv.asset_type !== 'INDIAN_STOCK') continue;

    const firstUnitInflow = firstUnitInflowByInvestment.get(invId);
    if (!firstUnitInflow || firstUnitInflow.transactionType !== 'IPO' || !firstUnitInflow.date) continue;

    const invEndDate = fetchEndByInvestment.get(invId) || runDate;
    if (!invEndDate || firstUnitInflow.date > invEndDate) continue;

    const series = cache.stockByInvestment.get(invId) || new Map();

    const ipoFillResult = backfillPreProviderIpoSessions({
      investmentId: invId,
      instrumentType: 'INDIAN_STOCK',
      symbol: inv.ticker_symbol || null,
      fillStartDate: firstUnitInflow.date,
      fillEndDate: invEndDate,
      seriesMap: series,
    });
    if (!ipoFillResult) continue;

    cache.stockByInvestment.set(invId, series);

    logBackfillInfo('[Backfill][IPO] Backfilled pre-provider IPO sessions in investment market cache', {
      investmentId: invId,
      investmentName: inv.name,
      tickerSymbol: inv.ticker_symbol || null,
      ipoDate: firstUnitInflow.date,
      firstProviderDate: ipoFillResult.firstProviderDate,
      ipoFilledSessions: ipoFillResult.ipoFilledSessions,
      maxAllowedSessions: IPO_CACHE_FILL_MAX_SESSIONS,
    });
  }

  // Emit sparse coverage warnings only after IPO pre-provider backfill has run,
  // so warnings reflect true unresolved gaps.
  for (const invId of stockInvIds) {
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = fetchEndByInvestment.get(invId) || runDate;
    if (!startDate || !endDate || startDate > endDate) continue;

    const inv = invMap.get(invId);

    const seriesRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    const seriesMap = new Map(seriesRows.map((row) => [row.date, Number(row.adj_close ?? row.close)]));
    cache.stockByInvestment.set(invId, seriesMap);

    const instrumentType = inferStockInstrumentType(inv?.ticker_symbol || null, inv?.asset_type || null);
    const sessions = getMarketSessionDates(startDate, endDate, instrumentType);
    const providerSymbol = String(inv?.ticker_symbol || seriesRows.find((row) => row?.symbol)?.symbol || '').trim();
    const locfCoverableDates = getLocfCoverableSessionDates(seriesRows, sessions, instrumentType, runDate);
    const missingSessionDates = sessions.filter((d) => !seriesMap.has(d) && !locfCoverableDates.has(d));
    const firstMissingDate = missingSessionDates[0] || null;
    if (!firstMissingDate) continue;

    let shouldWarnSparseCoverage = true;
    let warningSuppressedReason = null;

    if (instrumentType === 'FOREIGN_STOCK') {
      const ist = getIstClock();
      const foreignEdgeDates = new Set([ist.date, addDays(ist.date, -1)]);
      const hasOnlyEdgeMissing = missingSessionDates.every((d) => foreignEdgeDates.has(d));
      if (hasOnlyEdgeMissing) {
        shouldWarnSparseCoverage = false;
        warningSuppressedReason = missingSessionDates.includes(ist.date)
          ? 'FOREIGN_SAME_DAY_PENDING'
          : 'FOREIGN_PREVIOUS_DAY_PENDING';
      }
    }

    if (shouldWarnSparseCoverage && instrumentType === 'INDIAN_STOCK' && firstMissingDate === endDate) {
      const ist = getIstClock();
      if (endDate === ist.date && ist.minutes < STOCK_CACHE_WARN_INDIAN_SETTLEMENT_CUTOFF_MINUTES_IST) {
        shouldWarnSparseCoverage = false;
        warningSuppressedReason = 'INDIAN_SAME_DAY_PENDING';
      }
    }

    if (shouldWarnSparseCoverage && firstMissingDate >= runDate) {
      shouldWarnSparseCoverage = false;
      warningSuppressedReason = 'SAME_DAY_CACHE_PENDING';
    }

    if (shouldWarnSparseCoverage) {
      logBackfillWarn('[Backfill][StockCache] Coverage still sparse after hydration for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        tickerSymbol: inv?.ticker_symbol || null,
        startDate,
        endDate,
        cachedPoints: seriesMap.size,
        expectedSessions: sessions.length,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        maxContiguousMissingSessions: getMaxContiguousMissingCount(sessions, new Set([...seriesMap.keys(), ...locfCoverableDates])),
        locfCoverableSessions: locfCoverableDates.size,
      });
    } else {
      logBackfillInfo('[Backfill][StockCache] Sparse coverage warning suppressed for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        tickerSymbol: inv?.ticker_symbol || null,
        startDate,
        endDate,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        reason: warningSuppressedReason,
      });
    }
  }

  // Emit sparse coverage warnings for SGB investments
  const sgbInvIds = Array.from(invMap.values())
    .filter((inv) => inv?.asset_type === 'SGB')
    .map((inv) => inv.id);
  for (const invId of sgbInvIds) {
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = sgbEndByInvestment.get(invId) || runDate;
    if (!startDate || !endDate || startDate > endDate) continue;

    const inv = invMap.get(invId);
    const seriesRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    const seriesMap = new Map(seriesRows.map((row) => [row.date, Number(row.close)]));

    const sessions = getMarketSessionDates(startDate, endDate, 'SGB');
    const providerSymbol = String(inv?.ticker_symbol || seriesRows.find((row) => row?.symbol)?.symbol || '').trim();
    const locfCoverableDates = getLocfCoverableSessionDates(seriesRows, sessions, 'SGB', runDate);
    const missingSessionDates = sessions.filter((d) => !seriesMap.has(d) && !locfCoverableDates.has(d));
    const firstMissingDate = missingSessionDates[0] || null;
    if (!firstMissingDate) continue;

    let shouldWarnSparseCoverage = true;
    let warningSuppressedReason = null;

    if (shouldWarnSparseCoverage && firstMissingDate >= runDate) {
      shouldWarnSparseCoverage = false;
      warningSuppressedReason = 'SAME_DAY_CACHE_PENDING';
    }

    if (shouldWarnSparseCoverage) {
      logBackfillWarn('[Backfill][SGBCache] Coverage still sparse after hydration for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        symbol: inv?.ticker_symbol || null,
        startDate,
        endDate,
        cachedPoints: seriesMap.size,
        expectedSessions: sessions.length,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        maxContiguousMissingSessions: getMaxContiguousMissingCount(sessions, new Set([...seriesMap.keys(), ...locfCoverableDates])),
        locfCoverableSessions: locfCoverableDates.size,
      });
    } else {
      logBackfillInfo('[Backfill][SGBCache] Sparse coverage warning suppressed for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        symbol: inv?.ticker_symbol || null,
        startDate,
        endDate,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        reason: warningSuppressedReason,
      });
    }
  }

  const mfEndByInvestment = getHoldingsCappedFetchEndDates(db, scopeList, invMap, runDate, ['MUTUAL_FUND']);
  const npsEndByInvestment = getHoldingsCappedFetchEndDates(db, scopeList, invMap, runDate, ['NPS']);

  // Emit sparse coverage warnings for MUTUAL_FUND investments
  const mfInvIds = Array.from(invMap.values())
    .filter((inv) => inv?.asset_type === 'MUTUAL_FUND')
    .map((inv) => inv.id);
  for (const invId of mfInvIds) {
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = mfEndByInvestment.get(invId) || marketCacheEndDate;
    if (!startDate || !endDate || startDate > endDate) continue;

    const inv = invMap.get(invId);
    const seriesRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    const seriesMap = new Map(seriesRows.map((row) => [row.date, Number(row.close)]));

    const sessions = getMarketSessionDates(startDate, endDate, 'MUTUAL_FUND');
    const providerSymbol = String(inv?.amfi_code || inv?.ticker_symbol || seriesRows.find((row) => row?.symbol)?.symbol || '').trim();
    const locfCoverableDates = getLocfCoverableSessionDates(seriesRows, sessions, 'MUTUAL_FUND', runDate);
    const missingSessionDates = sessions.filter((d) => !seriesMap.has(d) && !locfCoverableDates.has(d));
    const firstMissingDate = missingSessionDates[0] || null;
    if (!firstMissingDate) continue;

    let shouldWarnSparseCoverage = true;
    let warningSuppressedReason = null;

    if (shouldWarnSparseCoverage && firstMissingDate >= runDate) {
      shouldWarnSparseCoverage = false;
      warningSuppressedReason = 'SAME_DAY_CACHE_PENDING';
    }

    if (shouldWarnSparseCoverage) {
      logBackfillWarn('[Backfill][MFCache] Coverage still sparse after hydration for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        fundCode: inv?.ticker_symbol || null,
        startDate,
        endDate,
        cachedPoints: seriesMap.size,
        expectedSessions: sessions.length,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        maxContiguousMissingSessions: getMaxContiguousMissingCount(sessions, new Set([...seriesMap.keys(), ...locfCoverableDates])),
        locfCoverableSessions: locfCoverableDates.size,
      });
    } else {
      logBackfillInfo('[Backfill][MFCache] Sparse coverage warning suppressed for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        fundCode: inv?.ticker_symbol || null,
        startDate,
        endDate,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        reason: warningSuppressedReason,
      });
    }
  }

  // Emit sparse coverage warnings for NPS investments
  const npsInvIds = Array.from(invMap.values())
    .filter((inv) => inv?.asset_type === 'NPS')
    .map((inv) => inv.id);
  for (const invId of npsInvIds) {
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = npsEndByInvestment.get(invId) || marketCacheEndDate;
    if (!startDate || !endDate || startDate > endDate) continue;

    const inv = invMap.get(invId);
    const seriesRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    const seriesMap = new Map(seriesRows.map((row) => [row.date, Number(row.close)]));

    const sessions = getMarketSessionDates(startDate, endDate, 'NPS');
    const providerSymbol = String(inv?.nps_fund_code || inv?.ticker_symbol || seriesRows.find((row) => row?.symbol)?.symbol || '').trim();
    const locfCoverableDates = getLocfCoverableSessionDates(seriesRows, sessions, 'NPS', runDate);
    const missingSessionDates = sessions.filter((d) => !seriesMap.has(d) && !locfCoverableDates.has(d));
    const firstMissingDate = missingSessionDates[0] || null;
    if (!firstMissingDate) continue;

    let shouldWarnSparseCoverage = true;
    let warningSuppressedReason = null;

    if (shouldWarnSparseCoverage && firstMissingDate >= runDate) {
      shouldWarnSparseCoverage = false;
      warningSuppressedReason = 'SAME_DAY_CACHE_PENDING';
    }

    if (shouldWarnSparseCoverage) {
      logBackfillWarn('[Backfill][NPSCache] Coverage still sparse after hydration for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        scheme: inv?.ticker_symbol || null,
        startDate,
        endDate,
        cachedPoints: seriesMap.size,
        expectedSessions: sessions.length,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        maxContiguousMissingSessions: getMaxContiguousMissingCount(sessions, new Set([...seriesMap.keys(), ...locfCoverableDates])),
        locfCoverableSessions: locfCoverableDates.size,
      });
    } else {
      logBackfillInfo('[Backfill][NPSCache] Sparse coverage warning suppressed for investment', {
        investmentId: invId,
        investmentName: inv?.name || null,
        scheme: inv?.ticker_symbol || null,
        startDate,
        endDate,
        firstMissingDate,
        missingSessionCount: missingSessionDates.length,
        reason: warningSuppressedReason,
      });
    }
  }

  const foreignStockInvIds = stockInvIds.filter((invId) => {
    const inv = invMap.get(invId);
    return inv && inv.asset_type === 'FOREIGN_STOCK';
  });

  let foreignMaterialized = 0;
  for (const invId of foreignStockInvIds) {
    const inv = invMap.get(invId);
    const symbol = normalizeStockSymbol(inv?.ticker_symbol, inv?.asset_type);
    const startDate = fetchStartByInvestment.get(invId);
    const endDate = fetchEndByInvestment.get(invId) || marketCacheEndDate;
    if (!inv || !symbol || !startDate || !endDate || startDate > endDate) continue;

    const rows = getSeries('FOREIGN_STOCK', symbol, startDate, endDate).filter((row) => row?.close != null);

    if (rows.length > 0) {
      const points = rows.map((row) => ({
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        adjClose: row.adj_close,
        volume: row.volume,
        source: row.source,
      }));
      upsertInvestmentPriceSeries(invId, 'FOREIGN_STOCK', symbol, points, null);
      foreignMaterialized += 1;
    }

    const updatedRows = getInvestmentSeries(invId, startDate, endDate).filter((row) => row?.close != null);
    cache.stockByInvestment.set(
      invId,
      new Map(updatedRows.map((row) => [row.date, Number(row.adj_close ?? row.close)]))
    );
  }

  if (stockInvIds.length > 0) {
    const sparseCount = stockInvIds.filter((id) => {
      const inv = invMap.get(id);
      const s = fetchStartByInvestment.get(id);
      const e = fetchEndByInvestment.get(id) || marketCacheEndDate;
      if (!s || !e || s > e) return false;
      const rows = cache.stockByInvestment.get(id);
      return rows && rows.size === 0;
    }).length;
    logBackfillInfo('[Backfill][Stocks] Prewarm completed.', {
      investments: stockInvIds.length,
      foreignStocks: stockInvIds.filter((id) => invMap.get(id)?.asset_type === 'FOREIGN_STOCK').length,
      indianStocks: stockInvIds.filter((id) => invMap.get(id)?.asset_type === 'INDIAN_STOCK').length,
    });
  }

  if (foreignStockInvIds.length > 0) {
    logBackfillInfo('[Backfill][Foreign] Cache materialization completed.', {
      investments: foreignStockInvIds.length,
      materialized: foreignMaterialized,
    });
  }

  const mfWindows = [];
  const mfHydrationWindows = [];
  const mfCodeWindows = new Map();

  const addMfCodeRange = (code, startDate, endDate) => {
    if (!code || !startDate || !endDate) return;
    const existingRange = mfCodeWindows.get(code);
    if (!existingRange) {
      mfCodeWindows.set(code, { startDate, endDate });
      return;
    }
    if (startDate < existingRange.startDate) existingRange.startDate = startDate;
    if (endDate > existingRange.endDate) existingRange.endDate = endDate;
  };

  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv || inv.asset_type !== 'MUTUAL_FUND') continue;

    const startDate = startByInvestment.get(inv.id) || s.dirty_from_date;
    const endDate = mfEndByInvestment.get(inv.id) || marketCacheEndDate;
    if (!startDate || !endDate || startDate > endDate) continue;

    mfWindows.push({
      investmentId: inv.id,
      startDate,
      endDate,
    });

    const currentCode = normalizeMutualFundCode(inv.amfi_code);
    if (currentCode) addMfCodeRange(currentCode, startDate, endDate);

    const historyRows = cache.symbolHistoryByInvestment?.get(inv.id) || [];
    for (const row of historyRows) {
      const historyCode = normalizeMutualFundCode(row.symbol);
      if (!historyCode) continue;
      const rowStart = row.validFrom || startDate;
      const rowEnd = row.validTo || endDate;
      const overlapStart = rowStart > startDate ? rowStart : startDate;
      const overlapEnd = rowEnd < endDate ? rowEnd : endDate;
      if (overlapStart > overlapEnd) continue;
      addMfCodeRange(historyCode, overlapStart, overlapEnd);
    }
  }

  for (const window of mfWindows) {
    const inv = invMap.get(window.investmentId);
    if (!inv) continue;

    const existingInvestmentRows = getInvestmentSeries(
      window.investmentId,
      window.startDate,
      window.endDate
    ).filter((row) => row?.close != null);

    const investmentSessions = getMarketSessionDates(window.startDate, window.endDate, 'MUTUAL_FUND');
    if (hasCompleteInvestmentCoverage(existingInvestmentRows, investmentSessions)) {
      continue;
    }

    const missingSegments = getMissingMarketSessionSegments(existingInvestmentRows, investmentSessions);
    const codeWindows = buildMissingMutualFundWindows(inv, missingSegments, cache);
    for (const codeWindow of codeWindows) {
      if (!codeWindow?.code || !codeWindow?.startDate || !codeWindow?.endDate) continue;
      mfHydrationWindows.push({
        investmentId: window.investmentId,
        code: codeWindow.code,
        startDate: codeWindow.startDate,
        endDate: codeWindow.endDate,
      });
      addMfCodeRange(codeWindow.code, codeWindow.startDate, codeWindow.endDate);
    }
  }

  const mergedMfHydrationWindows = [];
  const mergedMfWindowByKey = new Map();
  for (const window of mfHydrationWindows) {
    const key = `${window.investmentId}|${window.code}`;
    const existing = mergedMfWindowByKey.get(key);
    if (!existing) {
      const merged = { ...window };
      mergedMfWindowByKey.set(key, merged);
      mergedMfHydrationWindows.push(merged);
      continue;
    }
    if (window.startDate < existing.startDate) existing.startDate = window.startDate;
    if (window.endDate > existing.endDate) existing.endDate = window.endDate;
  }

  for (const window of mergedMfHydrationWindows) {
    const existingInvestmentRows = getInvestmentSeries(
      window.investmentId,
      window.startDate,
      window.endDate
    ).filter((row) => row?.close != null);
    const investmentSessions = getMarketSessionDates(window.startDate, window.endDate, 'MUTUAL_FUND');
    if (hasCompleteInvestmentCoverage(existingInvestmentRows, investmentSessions)) {
      continue;
    }

    const rows = await hydrateHistoricalPriceSeries({
      instrumentType: 'MUTUAL_FUND',
      symbol: window.code,
      fromDate: window.startDate,
      toDate: window.endDate,
      freshnessSkipFromDate: runDate,
      sourceLabel: 'AMFI',
      fetchRange: async () => fetchMutualFundHistory(window.code).catch((err) => {
        logBackfillError(`[Backfill][Funds] Provider fetch failed for ${window.code}: ${err?.message || err}`);
        return [];
      }),
      contextMeta: {
        investmentId: window.investmentId,
        investmentIds: [window.investmentId],
      },
      mapFetchedRows: (rows) => (Array.isArray(rows) ? rows : []).map((row) => {
        const d = normalizeMfDate(row?.date);
        const nav = Number(row?.nav);
        if (!d || !Number.isFinite(nav) || nav <= 0) return null;
        return { date: d, close: nav, source: 'AMFI' };
      }).filter(Boolean),
      onInfo: (message, meta) => logBackfillInfo(`[Backfill][Funds] ${message}`, meta),
    }).catch((err) => {
      logBackfillError(`[Backfill][Funds] Hydration failed for ${window.code}: ${err?.message || err}`);
      return [];
    });

    if (rows.length > 0) {
      const points = rows.map((row) => ({
        date: row.date,
        close: row.close,
        source: row.source,
      }));
      upsertInvestmentPriceSeries(window.investmentId, 'MUTUAL_FUND', window.code, points, null);
    }
  }

  cache.mf = cache.mf || new Map();
  for (const [code, range] of mfCodeWindows.entries()) {
    const localMap = loadSeriesMapFromLocalCache('MUTUAL_FUND', code, range.startDate, range.endDate, (row) => row.close);
    cache.mf.set(code, localMap);
  }

  cache.mfByInvestment = cache.mfByInvestment || new Map();
  for (const window of mfWindows) {
    const localMap = loadInvestmentSeriesMapFromLocalCache(window.investmentId, window.startDate, window.endDate, (row) => row.close);
    cache.mfByInvestment.set(window.investmentId, localMap);
  }

  if (mfCodeWindows.size > 0) {
    logBackfillInfo('[Backfill][Funds] Prewarm completed.', {
      fundCodes: mfCodeWindows.size,
      investments: mfWindows.length,
    });
  }

  const npsWindows = [];
  const npsCodeWindows = new Map();
  const npsHydrationWindows = [];
  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv || inv.asset_type !== 'NPS') continue;
    const code = String(inv.nps_fund_code || '').trim();
    if (!code) continue;
    const startDate = startByInvestment.get(inv.id) || s.dirty_from_date;
    const endDate = npsEndByInvestment.get(inv.id) || marketCacheEndDate;
    if (!endDate || startDate > endDate) continue;
    if (!startDate) continue;
    npsWindows.push({
      investmentId: inv.id,
      code,
      startDate,
      endDate,
    });

    const existingRange = npsCodeWindows.get(code);
    if (!existingRange) {
      npsCodeWindows.set(code, { startDate, endDate });
    } else {
      if (startDate < existingRange.startDate) existingRange.startDate = startDate;
      if (endDate > existingRange.endDate) existingRange.endDate = endDate;
    }
  }

  cache.nps = cache.nps || new Map();
  for (const window of npsWindows) {
    const inv = invMap.get(window.investmentId);
    if (!inv) continue;

    const existingInvestmentRows = getInvestmentSeries(
      window.investmentId,
      window.startDate,
      window.endDate
    ).filter((row) => row?.close != null);
    const investmentSessions = getMarketSessionDates(window.startDate, window.endDate, 'NPS');
    if (hasCompleteInvestmentCoverage(existingInvestmentRows, investmentSessions)) {
      continue;
    }

    const missingSegments = getMissingMarketSessionSegments(existingInvestmentRows, investmentSessions);
    const codeWindows = buildMissingNpsWindows(inv, missingSegments);
    for (const codeWindow of codeWindows) {
      if (!codeWindow?.code || !codeWindow?.startDate || !codeWindow?.endDate) continue;
      npsHydrationWindows.push({
        investmentId: window.investmentId,
        code: codeWindow.code,
        startDate: codeWindow.startDate,
        endDate: codeWindow.endDate,
      });
    }
  }

  const mergedNpsHydrationWindows = [];
  const mergedNpsWindowByKey = new Map();
  for (const window of npsHydrationWindows) {
    const key = `${window.investmentId}|${window.code}`;
    const existing = mergedNpsWindowByKey.get(key);
    if (!existing) {
      const merged = { ...window };
      mergedNpsWindowByKey.set(key, merged);
      mergedNpsHydrationWindows.push(merged);
      continue;
    }
    if (window.startDate < existing.startDate) existing.startDate = window.startDate;
    if (window.endDate > existing.endDate) existing.endDate = window.endDate;
  }

  const npsFreshnessSkipFromDate = addDays(toIsoDate(runDate) || todayIso(), -2);

  for (const window of mergedNpsHydrationWindows) {
    const existingInvestmentRows = getInvestmentSeries(
      window.investmentId,
      window.startDate,
      window.endDate
    ).filter((row) => row?.close != null);
    const investmentSessions = getMarketSessionDates(window.startDate, window.endDate, 'NPS');
    if (hasCompleteInvestmentCoverage(existingInvestmentRows, investmentSessions)) {
      continue;
    }

    const rows = await hydrateHistoricalPriceSeries({
      instrumentType: 'NPS',
      symbol: window.code,
      fromDate: window.startDate,
      toDate: window.endDate,
      freshnessSkipFromDate: npsFreshnessSkipFromDate,
      sourceLabel: 'NPS',
      fetchRange: async (missingFrom, missingTo) => fetchNPSHistory(window.code, missingFrom, missingTo).catch((err) => {
        logBackfillError(`[Backfill][NPS] Provider fetch failed for ${window.code}: ${err?.message || err}`);
        return [];
      }),
      contextMeta: {
        investmentId: window.investmentId,
        investmentIds: [window.investmentId],
      },
      mapFetchedRows: (rows) => (Array.isArray(rows) ? rows : []).map((row) => {
        const d = normalizeMfDate(row?.date);
        const nav = Number(row?.nav);
        if (!d || !isValidNpsNav(nav)) return null;
        return { date: d, close: nav, source: 'NPS' };
      }).filter(Boolean),
      onInfo: (message, meta) => logBackfillInfo(`[Backfill][NPS] ${message}`, meta),
    }).catch((err) => {
      logBackfillError(`[Backfill][NPS] Hydration failed for ${window.code}: ${err?.message || err}`);
      return [];
    });

    if (rows.length > 0) {
      const points = rows.map((row) => ({
        date: row.date,
        close: row.close,
        source: row.source,
      }));
      upsertInvestmentPriceSeries(window.investmentId, 'NPS', window.code, points, null);
    }
  }

  for (const [code, range] of npsCodeWindows.entries()) {
    const localMap = loadSeriesMapFromLocalCache('NPS', code, range.startDate, range.endDate, (row) => row.close);
    const filteredMap = new Map();
    for (const [d, v] of localMap.entries()) {
      if (isValidNpsNav(v)) filteredMap.set(d, Number(v));
    }
    cache.nps.set(code, filteredMap);
  }

  if (npsCodeWindows.size > 0) {
    logBackfillInfo('[Backfill][NPS] Prewarm completed.', {
      fundCodes: npsCodeWindows.size,
      investments: npsWindows.length,
    });
  }

  const {
    windows: foreignFxWindows,
    metaByInvestment: foreignFxMetaByInvestment,
  } = getForeignStockFxWindowsForRun(db, runDate);

  if (foreignFxWindows.length > 0) {
    const fxStart = foreignFxWindows.reduce((m, w) => (w.startDate < m ? w.startDate : m), foreignFxWindows[0].startDate);
    const fxEnd = foreignFxWindows.reduce((m, w) => (w.endDate > m ? w.endDate : m), foreignFxWindows[0].endDate);

    let fxHydrationError = null;
    let fxHydrationStats = null;

    await fetchHistoricalUSDToINRRange(fxStart, fxEnd).then((stats) => {
      fxHydrationStats = stats;
      logBackfillInfo('[Backfill][FX] Authoritative FX hydration completed.', {
        symbol: 'USDINR=X',
        startDate: fxStart,
        endDate: fxEnd,
        ...(stats || {}),
      });
    }).catch((err) => {
      fxHydrationError = err?.message || String(err);
      logBackfillError(`[Backfill][FX] Hydration failed for USDINR=X: ${err?.message || err}`);
      return null;
    });

    const fxExact = loadSeriesMapFromLocalCache('FX', 'USDINR=X', fxStart, fxEnd, (row) => row.close);
    const fxSessionDates = getMarketSessionDates(fxStart, fxEnd, 'FOREIGN_STOCK');
    let carry = getLocalFxRateOnOrBefore(fxStart);
    // LOCF is never persisted to fx_rate_cache. We still carry forward in-memory so
    // ongoing backfill calculations have a rate to use for provider-gap sessions.
    for (const d of fxSessionDates) {
      const exact = fxExact.get(d);
      if (exact != null && Number.isFinite(Number(exact)) && Number(exact) > 0) {
        carry = Number(exact);
      }
      // Always populate in-memory cache for any date in the window so backfill
      // calculations have a carry-forward rate even for the most recent sessions.
      if (carry != null && Number.isFinite(Number(carry)) && Number(carry) > 0) {
        cache.fx.set(d, Number(carry));
      }
    }

    for (const window of foreignFxWindows) {
      const sessions = getMarketSessionDates(window.startDate, window.endDate, 'FOREIGN_STOCK');
      const firstMissingDate = sessions.find((d) => !cache.fx.has(d));
      if (!firstMissingDate) continue;

      const inv = invMap.get(window.investmentId);
      const invMeta = foreignFxMetaByInvestment.get(window.investmentId) || {};
      const missingSessions = sessions.reduce((count, d) => (cache.fx.has(d) ? count : count + 1), 0);
      logBackfillWarn('[Backfill][FXCache] Coverage still sparse after hydration for foreign investment', {
        investmentId: window.investmentId,
        investmentName: inv?.name || invMeta.investmentName || null,
        tickerSymbol: inv?.ticker_symbol || invMeta.tickerSymbol || null,
        startDate: window.startDate,
        endDate: window.endDate,
        isExited: !!window.isExited,
        netUnits: window.netUnits,
        maxTxnDate: window.maxTxnDate || null,
        expectedSessions: sessions.length,
        cachedPointsInWindow: sessions.length - missingSessions,
        missingSessions,
        firstMissingDate,
      });
    }

    if (fxHydrationError) {
      logBackfillWarn('[Backfill][FX] Prewarm completed with errors.', {
        symbol: 'USDINR=X',
        startDate: fxStart,
        endDate: fxEnd,
        cachedPoints: cache.fx.size,
        hydrationError: fxHydrationError,
      });
    } else {
      logBackfillInfo('[Backfill][FX] Prewarm completed.', {
        symbol: 'USDINR=X',
        startDate: fxStart,
        endDate: fxEnd,
        cachedPoints: cache.fx.size,
        ...(fxHydrationStats || {}),
      });
    }
  }
}

async function processAutoBackfillCAEntries(db, options = {}) {
  const {
    scopeList = [],
    runDate = todayIso(),
    invMap = new Map(),
    cache,
    startByInvestment = new Map(),
    applyChanges = false,
  } = options;

  let inserted = 0;
  let updated = 0;
  let earliestChangedDate = null;
  const allCaChanges = [];

  const invIds = Array.from(new Set(scopeList.map((s) => s.investment_id).filter((id) => id != null)));
  const corporateActionSyncPairs = new Map();
  const investmentBoundsById = new Map();
  if (invIds.length) {
    const boundsPlaceholders = invIds.map(() => '?').join(',');
    const boundsRows = db.prepare(`
      SELECT
        investment_id,
        MIN(date(transaction_date)) AS min_txn_date,
        MAX(date(transaction_date)) AS max_txn_date,
        COALESCE(SUM(
          CASE
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
            ELSE 0
          END
        ), 0) AS net_units
      FROM transactions
      WHERE investment_id IN (${boundsPlaceholders})
        AND date(transaction_date) <= ?
      GROUP BY investment_id
    `).all(...invIds, runDate);

    for (const row of boundsRows) {
      const minTxnDate = toIsoDate(row?.min_txn_date) || null;
      const maxTxnDate = toIsoDate(row?.max_txn_date) || null;
      const netUnits = Number(row?.net_units || 0);
      const isExited = Math.abs(netUnits) <= EXITED_UNITS_EPSILON;
      
      // Compute the last holding window endDate: when cumulative units last transitioned at or below epsilon
      // This is more reliable than maxTxnDate, which could include corrective/fee transactions after exit
      // Uses same epsilon threshold as isExited check for consistency
      let lastHoldingWindowEnd = maxTxnDate; // default fallback
      if (isExited && maxTxnDate) {
        const lastExitRow = db.prepare(`
          WITH txn_units AS (
            SELECT
              date(transaction_date) AS tx_date,
              COALESCE(SUM(
                CASE
                  WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
                  WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
                  ELSE 0
                END
              ), 0) AS units_delta
            FROM transactions
            WHERE investment_id = ?
            GROUP BY date(transaction_date)
            ORDER BY date(transaction_date) ASC
          ),
          cumulative_units AS (
            SELECT
              tx_date,
              SUM(units_delta) OVER (ORDER BY tx_date) AS cumul_units
            FROM txn_units
          )
          SELECT MAX(tx_date) AS last_exit_date
          FROM cumulative_units
          WHERE cumul_units > ?
        `).get(row.investment_id, EXITED_UNITS_EPSILON);
        
        const computedExitDate = toIsoDate(lastExitRow?.last_exit_date);
        lastHoldingWindowEnd = computedExitDate || maxTxnDate;
      }
      
      const boundedEndDate = (lastHoldingWindowEnd && lastHoldingWindowEnd < runDate) ? lastHoldingWindowEnd : runDate;
      investmentBoundsById.set(Number(row.investment_id), {
        minTxnDate,
        maxTxnDate,
        netUnits,
        boundedEndDate,
      });
    }

    const placeholders = invIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT investment_id, portfolio_id
      FROM transactions
      WHERE investment_id IN (${placeholders})
        AND portfolio_id IS NOT NULL
        AND date(transaction_date) <= ?
    `).all(...invIds, runDate);

    for (const row of rows) {
      const bounds = investmentBoundsById.get(Number(row.investment_id)) || null;
      const startFromScope = startByInvestment.get(row.investment_id) || runDate;
      const startFromTxn = bounds?.minTxnDate || null;
      const fromDate = (startFromTxn && startFromTxn > startFromScope) ? startFromTxn : startFromScope;
      const toDate = bounds?.boundedEndDate || runDate;
      if (!fromDate || !toDate || fromDate > toDate) {
        logBackfillWarn('[Backfill][CA] Skipping pair due to inconsistent CA window', {
          investmentId: row.investment_id,
          portfolioId: row.portfolio_id,
          fromDate: fromDate || null,
          toDate: toDate || null,
          minTxnDate: bounds?.minTxnDate || null,
          maxTxnDate: bounds?.maxTxnDate || null,
          netUnits: bounds?.netUnits ?? null,
        });
        continue;
      }

      const key = `${row.investment_id}:${row.portfolio_id}`;
      if (corporateActionSyncPairs.has(key)) continue;
      corporateActionSyncPairs.set(key, {
        investmentId: row.investment_id,
        portfolioId: row.portfolio_id,
        fromDate,
        toDate,
      });
    }
  }

  const bringDirtyDateEarlier = db.prepare(`
    UPDATE dirty_backfill_scope
    SET dirty_from_date = CASE
      WHEN dirty_from_date <= ? THEN dirty_from_date
      ELSE ?
    END,
    updated_at = datetime('now')
    WHERE investment_id = ?
      AND ((portfolio_id IS NULL AND ? IS NULL) OR portfolio_id = ?)
      AND status IN ('pending', 'running')
  `);

  const totalPairs = corporateActionSyncPairs.size;
  logBackfillInfo(`[Backfill][CA] Processing ${totalPairs} investment-portfolio pair(s)`);
  const stride = progressLogStride(totalPairs, 10);
  let donePairs = 0;

  const pairs = Array.from(corporateActionSyncPairs.values());
  const processOnePair = async (pair) => {
    const inv = invMap.get(pair.investmentId);
    if (!inv) return;

    const result = await syncCorporateActionsForScope(
      db,
      inv,
      pair.portfolioId,
      pair.fromDate,
      pair.toDate || runDate,
      cache,
      { dryRun: !applyChanges }
    );

    inserted += Number(result?.inserted || 0);
    updated += Number(result?.updated || 0);
    if (Array.isArray(result?.caChanges) && result.caChanges.length) {
      allCaChanges.push(...result.caChanges);
    }

    const changedDate = result?.earliestChangedDate || null;
    if (changedDate && (!earliestChangedDate || changedDate < earliestChangedDate)) {
      earliestChangedDate = changedDate;
    }

    if (applyChanges && changedDate) {
      mergeDirtyDateIntoScopes(scopeList, pair.investmentId, pair.portfolioId, changedDate, {
        cause: 'corporate-action-sync',
      });
      bringDirtyDateEarlier.run(changedDate, changedDate, pair.investmentId, pair.portfolioId, pair.portfolioId);
      bringDirtyDateEarlier.run(changedDate, changedDate, pair.investmentId, null, null);
    }
  };

  if (applyChanges || totalPairs <= 1) {
    for (const pair of pairs) {
      await processOnePair(pair);
      donePairs += 1;
      if (donePairs === totalPairs || donePairs % stride === 0) {
        logBackfillInfo(`[Backfill][CA] Progress ${donePairs}/${totalPairs} (inserted=${inserted}, updated=${updated})`);
      }
    }
  } else {
    const configuredConcurrency = Number(process.env.CA_SYNC_CONCURRENCY || 6);
    const maxConcurrency = Math.max(1, Math.min(12, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 6));
    const workerCount = Math.min(maxConcurrency, totalPairs);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= totalPairs) return;

        const pair = pairs[currentIndex];
        await processOnePair(pair);

        donePairs += 1;
        if (donePairs === totalPairs || donePairs % stride === 0) {
          logBackfillInfo(`[Backfill][CA] Progress ${donePairs}/${totalPairs} (inserted=${inserted}, updated=${updated})`);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  let suggestionSummary = null;
  if (!applyChanges && allCaChanges.length) {
    suggestionSummary = persistCorporateActionSuggestions(db, allCaChanges, 'auto_backfill');
    logBackfillInfo(
      `[Backfill][CA] Corporate action suggestions queued=${suggestionSummary.queued}, refreshed=${suggestionSummary.refreshed}, suppressed=${suggestionSummary.suppressed}, total=${suggestionSummary.total}`
    );
  }

  // RSU vest actualization runs as a sub-step of the CA sync (suggest mode only),
  // mirroring the corporate-action suggestion flow: it scans settled placeholder
  // VEST rows globally and queues accept/reject cards. FX is read strictly from the
  // prewarmed cache (no network); dirty-marking still happens later on manual accept.
  let rsuVestSummary = null;
  if (!applyChanges) {
    try {
      const resolveFxRate = async (date) => {
        const v = cache?.fx?.get(date);
        return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
      };
      rsuVestSummary = await generateVestSuggestions(db, {
        portfolioId: null,
        asOfDate: runDate,
        settleDays: 2,
        resolveFxRate,
      });
      if (rsuVestSummary.scanned > 0 || rsuVestSummary.queued > 0 || rsuVestSummary.refreshed > 0) {
        logBackfillInfo(
          `[Backfill][RSU-Vest] scanned=${rsuVestSummary.scanned}, queued=${rsuVestSummary.queued}, refreshed=${rsuVestSummary.refreshed}, suppressed=${rsuVestSummary.suppressed}, skipped=${rsuVestSummary.skipped}`
        );
      }
    } catch (rsuErr) {
      logBackfillWarn('[Backfill][RSU-Vest] Vest suggestion scan failed; continuing', {
        error: rsuErr?.message || String(rsuErr),
      });
    }
  }

  logBackfillInfo(`[Backfill][CA] Completed AutoBackfill CA. inserted=${inserted}, updated=${updated}, modified=${inserted + updated}, mode=${applyChanges ? 'apply' : 'suggest'}`);
  if (allCaChanges.length) {
    for (const change of allCaChanges) {
      logBackfillInfo('[Backfill][CA-Change] ' + JSON.stringify(change));
    }
  }

  return {
    inserted,
    updated,
    modified: inserted + updated,
    earliestChangedDate,
    caChanges: allCaChanges,
    suggestionSummary,
    rsuVestSummary,
    mode: applyChanges ? 'apply' : 'suggest',
  };
}

async function updateDailyValues(db, options = {}) {
  const {
    scopeList = [],
    runDate = todayIso(),
    invMap = new Map(),
    cache,
    suppressRunDateWritesForMarketLinked = false,
    suppressedRunDateAssetTypes = null,
  } = options;

  const details = [];
  let totalRows = 0;
  let completedScopes = 0;
  let earliestTouchedDate = runDate;
  let earliestAggregateDate = null;
  // Ground-truth probe: capture the DB clock BEFORE any recompute writes so that after
  // Step-3 we can detect the EARLIEST investment_metrics_daily date actually touched during this run
  // (via updated_at) and widen the rollup refresh accordingly. See Step-4 below.
  const aggregateFloorProbeTs = db.prepare("SELECT datetime('now') AS ts").get().ts;
  const forwardReplaySummary = {
    historicalScopeCount: 0,
    maxReplayDays: 0,
    reasons: new Map(),
    replayIntents: new Map(),
    backwardExpandedScopeCount: 0,
    maxBackwardExpansionDays: 0,
  };
  const totalScopes = scopeList.length;
  const stride = progressLogStride(totalScopes, 10);
  let lastScopeHeartbeatAt = Date.now();

  logBackfillStep(3, null, 'Recompute daily values', 'start', { totalScopes });

  const daysBetweenIso = (startIso, endIso) => {
    const start = Date.parse(`${startIso}T00:00:00.000Z`);
    const end = Date.parse(`${endIso}T00:00:00.000Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return Math.floor((end - start) / 86400000);
  };

  for (const scope of scopeList) {
    const inv = invMap.get(scope.investment_id);
    if (!inv) continue;

    const fromDate = scope.dirty_from_date;
    if (fromDate < earliestTouchedDate) earliestTouchedDate = fromDate;

    const replayDays = daysBetweenIso(fromDate, runDate);
    if (replayDays > 1) {
      forwardReplaySummary.historicalScopeCount += 1;
      if (replayDays > forwardReplaySummary.maxReplayDays) {
        forwardReplaySummary.maxReplayDays = replayDays;
      }
      const replayIntent = scope.replay_intent || classifyHistoricalReplayIntent(scope.dirty_reason, scope.source_event_id);
      forwardReplaySummary.replayIntents.set(
        replayIntent,
        (forwardReplaySummary.replayIntents.get(replayIntent) || 0) + 1
      );
      const reasonTokens = String(scope.dirty_reason || 'unspecified')
        .split('|')
        .map((token) => token.trim())
        .filter(Boolean);
      for (const token of reasonTokens) {
        const existingCount = forwardReplaySummary.reasons.get(token) || 0;
        forwardReplaySummary.reasons.set(token, existingCount + 1);
      }
      const requestedDirtyFromDate = scope.requested_dirty_from_date || fromDate;
      if (requestedDirtyFromDate && fromDate < requestedDirtyFromDate) {
        const widenedByDays = daysBetweenIso(fromDate, requestedDirtyFromDate);
        forwardReplaySummary.backwardExpandedScopeCount += 1;
        if (widenedByDays > forwardReplaySummary.maxBackwardExpansionDays) {
          forwardReplaySummary.maxBackwardExpansionDays = widenedByDays;
        }

        logBackfillWarn('[Backfill][ForwardOnly] Scope widened backward during processing.', {
          investmentId: scope.investment_id,
          portfolioId: scope.portfolio_id,
          requestedDirtyFromDate,
          effectiveDirtyFromDate: fromDate,
          runDate,
          replayDays,
          widenedByDays,
          dirtyReason: scope.dirty_reason || null,
          sourceEventId: scope.source_event_id || null,
          replayIntent,
          cause: scope.backward_expansion?.cause || null,
        });
      }
    }

    setBackfillProgress(db, {
      phase: 'running',
      total: scopeList.length,
      completed: completedScopes,
      current: {
        investment_id: scope.investment_id,
        portfolio_id: scope.portfolio_id,
        dirty_from_date: fromDate,
      },
      message: `Recomputing ${scope.investment_id}:${scope.portfolio_id ?? 'ALL'}`,
      runDate,
      startedAt: new Date().toISOString(),
    });

    const rows = await recomputeScopeRows(
      db,
      inv,
      scope.portfolio_id,
      fromDate,
      runDate,
      cache,
      ({ processedDays, totalDays, date }) => {
        if (!shouldHeartbeat(lastScopeHeartbeatAt, 60_000) && processedDays !== totalDays) return;
        lastScopeHeartbeatAt = Date.now();

        const scopeLabel = `${scope.investment_id}:${scope.portfolio_id ?? 'ALL'}`;
        const message = `Running scope ${completedScopes + 1}/${scopeList.length} (${scopeLabel}) day ${processedDays}/${totalDays} @ ${date}`;

        setBackfillProgress(db, {
          phase: 'running',
          total: scopeList.length,
          completed: completedScopes,
          current: {
            investment_id: scope.investment_id,
            portfolio_id: scope.portfolio_id,
            dirty_from_date: fromDate,
          },
          message,
          runDate,
          startedAt: new Date().toISOString(),
        });

        logBackfillInfo(`[Backfill][Heartbeat] ${message}`);
      },
      {
        suppressRunDateWritesForMarketLinked,
        suppressedRunDateAssetTypes,
      }
    );
    totalRows += rows;
    completedScopes += 1;
    if (rows > 0 && (earliestAggregateDate == null || fromDate < earliestAggregateDate)) {
      earliestAggregateDate = fromDate;
    }
    details.push({
      investment_id: scope.investment_id,
      portfolio_id: scope.portfolio_id,
      from_date: fromDate,
      to_date: runDate,
      rows,
    });

    setBackfillProgress(db, {
      phase: 'running',
      total: scopeList.length,
      completed: completedScopes,
      current: null,
      message: `Completed ${completedScopes}/${scopeList.length}`,
      runDate,
      startedAt: new Date().toISOString(),
    });

    if (completedScopes === totalScopes || completedScopes % stride === 0) {
      logBackfillInfo(`[Backfill][Progress] Scope ${completedScopes}/${totalScopes} complete | rowsWritten=${totalRows}`);
    }
  }

  if (forwardReplaySummary.historicalScopeCount > 0) {
    const topReasons = Array.from(forwardReplaySummary.reasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
    const topReplayIntents = Array.from(forwardReplaySummary.replayIntents.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count }));

    if (forwardReplaySummary.backwardExpandedScopeCount > 0) {
      logBackfillWarn('[Backfill][ForwardOnly] Backward widening summary.', {
        scopeCount: totalScopes,
        historicalScopeCount: forwardReplaySummary.historicalScopeCount,
        maxReplayDays: forwardReplaySummary.maxReplayDays,
        backwardExpandedScopeCount: forwardReplaySummary.backwardExpandedScopeCount,
        maxBackwardExpansionDays: forwardReplaySummary.maxBackwardExpansionDays,
        topReplayIntents,
        topReasons,
      });
    }
  }

  logBackfillStep(3, null, 'Recompute daily values', 'completed', {
    totalScopes,
    rowsWritten: totalRows,
  });

  // Robustness: the aggregate refresh window is normally derived from each dirty scope's
  // dirty_from_date. If a recompute rewrote investment_metrics_daily rows further back than expected
  // (or a wide historical rebuild ran), the rollup tables (portfolio_daily / asset_type_daily)
  // would silently drift out of sync with investment_metrics_daily. Widen the floor to the EARLIEST
  // investment_metrics_daily date actually touched during this run so the rollup rebuild always covers
  // every changed row rather than only the planned dirty_from_date.
  try {
    const touchedFloor = db.prepare(
      'SELECT MIN(date) AS d FROM investment_metrics_daily WHERE portfolio_id IS NOT NULL AND updated_at >= ?'
    ).get(aggregateFloorProbeTs)?.d || null;
    if (touchedFloor && (earliestAggregateDate == null || touchedFloor < earliestAggregateDate)) {
      logBackfillStep(4, 1, 'Resolve aggregate refresh floor', 'completed', {
        scopeDerivedEarliestAggregateDate: earliestAggregateDate,
        touchedFloor,
      });
      earliestAggregateDate = touchedFloor;
    }
  } catch (floorErr) {
    logBackfillWarn('[Backfill][Step-4.1] Resolve aggregate refresh floor failed; falling back to scope-derived earliestAggregateDate.', {
      error: floorErr.message,
    });
  }

  if (!earliestAggregateDate) {
    clearAggregateResumeState(db);
    setBackfillProgress(db, {
      phase: 'finalizing',
      total: scopeList.length,
      completed: scopeList.length,
      current: null,
      message: 'No daily-value changes detected; skipped aggregate refresh.',
      runDate,
      startedAt: new Date().toISOString(),
    });
    logBackfillStep(4, 2, 'Refresh aggregate tables', 'skipped', {
      reason: 'no-daily-value-rows-changed',
    });
    return {
      rowsWritten: totalRows,
      details,
      earliestTouchedDate,
    };
  }

  const previousResume = readAggregateResumeState(db);
  const canResume = previousResume
    && previousResume.runDate === runDate
    && previousResume.rangeStart === earliestAggregateDate
    && previousResume.rangeEnd === runDate
    && previousResume.nextDate
    && previousResume.nextDate >= earliestAggregateDate
    && previousResume.nextDate <= runDate;

  const aggregateStartDate = canResume ? previousResume.nextDate : earliestAggregateDate;
  const aggregateDates = eachDate(aggregateStartDate, runDate);
  const aggregateTotal = aggregateDates.length;
  const aggregateStride = progressLogStride(aggregateTotal, 20);
  let lastAggregateHeartbeatAt = Date.now();
  const aggregateStartedAtMs = Date.now();

  if (canResume) {
    logBackfillStep(4, 2, 'Refresh aggregate tables', 'resume', {
      aggregateStartDate,
      earliestAggregateDate,
      runDate,
    });
  } else {
    logBackfillStep(4, 2, 'Refresh aggregate tables', 'start', {
      earliestAggregateDate,
      runDate,
    });
  }

  const aggregateReplayDays = daysBetweenIso(earliestAggregateDate, runDate);
  if (aggregateReplayDays > 1) {
    const topReasons = Array.from(forwardReplaySummary.reasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
    const topReplayIntents = Array.from(forwardReplaySummary.replayIntents.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count }));

    const aggregateLogPayload = {
      aggregateFromDate: earliestAggregateDate,
      aggregateEffectiveFromDate: earliestAggregateDate,
      aggregateToDate: runDate,
      aggregateReplayDays,
      scopeCount: totalScopes,
      topReplayIntents,
      topReasons,
      backwardExpandedScopeCount: forwardReplaySummary.backwardExpandedScopeCount,
      maxBackwardExpansionDays: forwardReplaySummary.maxBackwardExpansionDays,
    };

    if (forwardReplaySummary.backwardExpandedScopeCount > 0) {
      logBackfillWarn('[Backfill][ForwardOnly] Aggregate refresh spans historical window due to backward widening during processing.', aggregateLogPayload);
    }
  }

  writeAggregateResumeState(db, {
    runDate,
    rangeStart: earliestAggregateDate,
    rangeEnd: runDate,
    nextDate: aggregateStartDate,
  });

  setBackfillProgress(db, {
    phase: 'finalizing',
    total: scopeList.length,
    completed: scopeList.length,
    current: null,
    message: `Refreshing daily aggregates: completed=0, remaining=${aggregateTotal}, progress=0.00%`,
    runDate,
    startedAt: new Date().toISOString(),
  });

  updateAggregateDailyRange(db, aggregateStartDate, runDate, {
    onProgress: (done, total, d) => {
      const nextDate = done < total ? addDays(d, 1) : null;
      if (nextDate) {
        writeAggregateResumeState(db, {
          runDate,
          rangeStart: earliestAggregateDate,
          rangeEnd: runDate,
          nextDate,
        });
      }

      const shouldLog = done === total || (done % aggregateStride === 0) || shouldHeartbeat(lastAggregateHeartbeatAt, 60_000);
      if (shouldLog) {
        lastAggregateHeartbeatAt = Date.now();
        const remaining = Math.max(total - done, 0);
        const pct = total > 0 ? (done / total) * 100 : 100;
        const elapsedMs = Math.max(Date.now() - aggregateStartedAtMs, 1);
        const perDayMs = done > 0 ? elapsedMs / done : 0;
        const etaMs = Math.max(Math.round(perDayMs * remaining), 0);
        const etaSeconds = Math.ceil(etaMs / 1000);
        const message = `Refreshing daily aggregates: completed=${done}/${total}, remaining=${remaining}, progress=${pct.toFixed(2)}%, current_date=${d}, eta_seconds=${etaSeconds}`;
        setBackfillProgress(db, {
          phase: 'finalizing',
          total: scopeList.length,
          completed: scopeList.length,
          current: null,
          message,
          runDate,
          startedAt: new Date().toISOString(),
        });
        logBackfillInfo(`[Backfill][Heartbeat] ${message}`);
      }
    },
  });

  clearAggregateResumeState(db);

  // Keep the canonical V2 projections in step with the rebuilt legacy aggregates.
  safeRebuildCanonicalProjections(db, { info: (m, meta) => logBackfillInfo(m, meta), warn: (m, meta) => logBackfillWarn(m, meta) });

  setBackfillProgress(db, {
    phase: 'finalizing',
    total: scopeList.length,
    completed: scopeList.length,
    current: null,
    message: 'Refreshing daily aggregates',
    runDate,
    startedAt: new Date().toISOString(),
  });

  logBackfillStep(4, 2, 'Refresh aggregate tables', 'completed', {
    fromDate: aggregateStartDate,
    toDate: runDate,
  });

  return {
    rowsWritten: totalRows,
    details,
    earliestTouchedDate,
  };
}

/**
 * Backfill scopes whose dirty_from_date is <= runDate.
 * Future-dated scopes are intentionally skipped until their date arrives.
 */
async function backfillDirtyScopes(db, scopes, options = {}) {
  const runDate = clampEndDateToToday(options.runDate || todayIso());
  const { eligible, scopeList } = normalizeScopesForRun(db, scopes, runDate);

  logBackfillInfo(`[Backfill] Eligible scopes for ${runDate}: ${eligible.length}/${(scopes || []).length}`);

  if (!eligible.length) {
    return {
      runDate,
      processed: 0,
      skippedFuture: (scopes || []).length,
      details: [],
    };
  }

  const step1ScopeList = buildGeneralizedStep1Scopes(db, scopeList, runDate);

  const invIds = Array.from(new Set(
    [...scopeList, ...step1ScopeList]
      .map((s) => s.investment_id)
      .filter((id) => id != null)
  ));
  const invMap = new Map();
  if (invIds.length) {
    const placeholders = invIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM investments WHERE id IN (${placeholders})`).all(...invIds);
    for (const row of rows) invMap.set(row.id, row);
  }

  const symbolHistoryByInvestment = loadSymbolHistoryByInvestment(db, invIds);

  const startByInvestment = getImpactedInvestmentStartDates(db, step1ScopeList, runDate);
  const fetchStartByInvestment = getMarketHistoryFetchStartDates(db, step1ScopeList, invMap, runDate);
  const fetchEndByInvestment = getMarketHistoryFetchEndDates(db, step1ScopeList, invMap, runDate);
  const cache = {
    mf: new Map(),
    nps: new Map(),
    stock: new Map(),
    sgb: new Map(),
    fx: new Map(),
    actions: new Map(),
    actionPromises: new Map(),
    dividendEvents: new Map(),
    dividendPromises: new Map(),
    localSplitEventsByInvestment: new Map(),
    ohlc: new Map(),
    symbolHistoryByInvestment,
    stockRangeBySymbol: new Map(),
    stockRangeEndBySymbol: new Map(),
    closedMarketDaysByYear: new Map(),
    warnedFallbacks: new Set(),
    allowNetworkFallback: false,
    phase: 'phase2_cache_build',
    runDate,
    rangeStart: Array.from(fetchStartByInvestment.values()).reduce((m, s) => (m == null || s < m ? s : m), null)
      || step1ScopeList.reduce((m, s) => (m == null || s.dirty_from_date < m ? s.dirty_from_date : m), null)
      || scopeList.reduce((m, s) => (m == null || s.dirty_from_date < m ? s.dirty_from_date : m), null)
      || runDate,
    rangeEnd: getMarketCacheEvaluationEndDate(runDate),
  };

  logBackfillStep(1, 1, 'Cache warm', 'start', {
    generalizedScopes: step1ScopeList.length,
    dirtyScopes: scopeList.length,
  });

  await preloadStockHistoryForRun(db, invMap, step1ScopeList, runDate, startByInvestment, fetchStartByInvestment, fetchEndByInvestment, cache);

  logBackfillStep(1, 1, 'Cache warm', 'completed', {
    generalizedScopes: step1ScopeList.length,
    dirtyScopes: scopeList.length,
  });

  logBackfillStep(2, 1, 'Corporate-action sync', 'start');

  const step1Result = await processAutoBackfillCAEntries(db, {
    scopeList,
    runDate,
    invMap,
    cache,
    startByInvestment,
  });

  logBackfillStep(2, 1, 'Corporate-action sync', 'completed', {
    caSuggested: step1Result?.modified || 0,
    caInserted: step1Result?.inserted || 0,
    caUpdated: step1Result?.updated || 0,
    rsuVestQueued: step1Result?.rsuVestSummary?.queued || 0,
    rsuVestRefreshed: step1Result?.rsuVestSummary?.refreshed || 0,
    rsuVestSuppressed: step1Result?.rsuVestSummary?.suppressed || 0,
  });

  if (options.step1Only === true) {
    logBackfillInfo(`[Backfill] Phase-1-only mode completed. modified=${Number(step1Result?.modified || 0)}`);  
    return {
      runDate,
      processed: scopeList.length,
      skippedFuture: (scopes || []).length - eligible.length,
      rowsWritten: 0,
      details: [],
      step1: step1Result,
    };
  }

  cache.phase = 'phase3_local_only';

  const step2Result = await updateDailyValues(db, {
    scopeList,
    runDate,
    invMap,
    cache,
    suppressRunDateWritesForMarketLinked: options.suppressRunDateWritesForMarketLinked === true,
    suppressedRunDateAssetTypes: options.suppressedRunDateAssetTypes || null,
  });

  return {
    runDate,
    processed: scopeList.length,
    skippedFuture: (scopes || []).length - eligible.length,
    rowsWritten: step2Result.rowsWritten,
    details: step2Result.details,
    step1: step1Result,
  };
}

async function runBackfillPipeline(db, options = {}) {
  const runDate = clampEndDateToToday(options.runDate || todayIso());
  const scopes = options.scopes || [];
  logBackfillInfo(`[Backfill] Starting backfill pipeline for ${runDate} with ${scopes.length} scope(s)...`, {
    pipelineName: 'dirty-scope-backfill',
    totalSteps: 4,
    steps: [
      { step: '1.1', name: 'Cache warm' },
      { step: '2.1', name: 'Corporate-action sync' },
      { step: '3', name: 'Recompute daily values' },
      { step: '4.2', name: 'Refresh aggregate tables' },
    ],
  });

  const result = await backfillDirtyScopes(db, scopes, {
    runDate,
    suppressRunDateWritesForMarketLinked: options.suppressRunDateWritesForMarketLinked === true,
    suppressedRunDateAssetTypes: options.suppressedRunDateAssetTypes || null,
  });
  logBackfillInfo('[Backfill] Backfill pipeline completed.', {
    pipelineName: 'dirty-scope-backfill',
    processed: result?.processed || 0,
    rowsWritten: result?.rowsWritten || 0,
    skippedFuture: result?.skippedFuture || 0,
  });
  return result;
}

async function backfillNPSHistoricalNAV(db, investmentId, startDate, endDate) {
  const { fetchNPSHistory } = require('./priceService');
  const { logBackfillInfo, logBackfillError } = require('./appLogger');

  try {
    logBackfillInfo(`[NPS Backfill] Starting backfill for investment ${investmentId} from ${startDate} to ${endDate}`);

    const inv = db.prepare('SELECT id, nps_fund_code FROM investments WHERE id = ?').get(investmentId);
    if (!inv?.nps_fund_code) {
      logBackfillInfo(`[NPS Backfill] Skipping ${investmentId}: nps_fund_code is missing`);
      return;
    }

    // Fetch historical NAV data
    const history = await fetchNPSHistory(inv.nps_fund_code, startDate, endDate);
    if (!history || history.length === 0) {
      logBackfillInfo(`[NPS Backfill] No historical data found for investment ${investmentId}`);
      return;
    }

    const from = toIsoDate(startDate);
    const to = toIsoDate(endDate);
    const filtered = [];
    const seen = new Set();
    for (const row of history) {
      const d = normalizeMfDate(row?.date);
      if (!d) continue;
      if (from && d < from) continue;
      if (to && d > to) continue;
      if (!isValidNpsNav(row?.nav)) continue;
      const key = `${investmentId}|${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push({ date: d, nav: Number(row.nav) });
    }
    if (filtered.length === 0) {
      logBackfillInfo(`[NPS Backfill] No valid NAV rows for investment ${investmentId} in requested date range`);
      return;
    }

    const portfolioIds = db.prepare(`
      SELECT DISTINCT portfolio_id
      FROM transactions
      WHERE investment_id = ?
        AND portfolio_id IS NOT NULL
        AND date(transaction_date) <= ?
    `).all(investmentId, to).map((r) => r.portfolio_id);

    if (!portfolioIds.length) {
      logBackfillInfo(`[NPS Backfill] Skipping ${investmentId}: no portfolio-scoped transactions found`);
      return;
    }

    // Insert or update daily values for each concrete portfolio scope.
    const upsertStmt = db.prepare(`
      INSERT INTO investment_metrics_daily (
        investment_id,
        portfolio_id,
        date,
        price_per_unit,
        total_units,
        current_value,
        invested_amount,
        realized_proceeds,
        profit_loss,
        price_source,
        day_change,
        updated_at
      )
      VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, 0, datetime('now'))
      ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
        price_per_unit = excluded.price_per_unit,
        price_source = excluded.price_source,
        updated_at = datetime('now')
    `);
    const selectExistingStmt = db.prepare(`
      SELECT price_per_unit, price_source
      FROM investment_metrics_daily
      WHERE investment_id = ? AND portfolio_id = ? AND date = ?
      LIMIT 1
    `);

    db.transaction(() => {
      for (const { date, nav } of filtered) {
        for (const pid of portfolioIds) {
          const existing = selectExistingStmt.get(investmentId, pid, date);
          let effectiveSource = 'COMPUTED';
          if (String(existing?.price_source || '').toUpperCase() === 'LIVE') {
            effectiveSource = 'LIVE';
            logBackfillWarn('[Backfill][NPS][SourceGuard] Prevented LIVE to COMPUTED downgrade', {
              investmentId,
              investmentName: inv?.name || null,
              portfolioId: pid,
              date,
              previousSource: existing?.price_source || null,
              attemptedSource: 'COMPUTED',
              persistedSource: effectiveSource,
              existingPricePerUnit: Number(existing?.price_per_unit || 0),
              attemptedPricePerUnit: Number(nav || 0),
              phase: 'backfill_nps_history',
            });
          }
          upsertStmt.run(investmentId, pid, date, nav, effectiveSource);
        }
      }
    })();

    logBackfillInfo(`[NPS Backfill] Successfully backfilled ${filtered.length * portfolioIds.length} rows for investment ${investmentId}`);
  } catch (error) {
    logBackfillError(`[NPS Backfill] Failed to backfill for investment ${investmentId}: ${error.message}`);
  }
}

module.exports = {
  backfillDirtyScopes,
  clampEndDateToToday,
  todayIso,
  toIsoDate,
  runBackfillPipeline,
  processAutoBackfillCAEntries,
  updateDailyValues,
  backfillNPSHistoricalNAV,
};
