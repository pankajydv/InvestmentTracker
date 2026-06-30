/**
 * Price fetching service for all asset types.
 *
 * - Mutual Funds: AMFI daily NAV API (free, no key needed)
 * - Indian Stocks: Yahoo Finance (NSE tickers with .NS suffix)
 * - Foreign Stocks: Yahoo Finance
 * - PPF/PF: Government-set interest rates (manual)
 */

const https = require('https');
const http = require('http');
const {
  upsertPricePoint,
  upsertPriceSeries,
  getSeries,
  getNearestOnOrBefore,
  hydrateHistoricalPriceSeries,
} = require('./marketPriceCache');
const {
  normalizeProviderDate,
  istDateFromUnixSeconds,
  utcDateFromUnixSeconds,
  formatIstDate,
  addDaysIso: addDaysIsoDate,
} = require('./dateUtils');

function isoDate(date) {
  return formatIstDate(date);
}

function addDaysIso(dateIso, days) {
  return addDaysIsoDate(dateIso, days);
}

function inferStockInstrumentType(symbol) {
  if (/\.(NS|BO)$/i.test(String(symbol || ''))) return 'INDIAN_STOCK';
  return 'FOREIGN_STOCK';
}

// ─── Market Hours & Staleness Helpers ─────────────────────────────────────────

/**
 * Advance dateIso by one calendar day at a time until we land on a US weekday.
 * Used to map after-hours trading to the NEXT trading session date.
 * @param {string} dateIso - YYYY-MM-DD
 * @returns {string}
 */
function nextUsWeekday(dateIso) {
  let cursor = addDaysIsoDate(dateIso, 1);
  // Infinite-loop-safe: worst case is skipping a 2-day weekend.
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(`${cursor}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) return cursor;
    cursor = addDaysIsoDate(cursor, 1);
  }
  return cursor;
}

/**
 * Determine the canonical US trading date and best available price from a Yahoo Finance
 * chart API response, correctly handling pre-market, regular, and after-hours sessions.
 *
 * Date attribution rules:
 *  - Pre-market (4 AM–9:30 AM EST) and regular session (9:30 AM–4 PM EST)
 *      → daily_values row for the US session date (exchange date)
 *  - After-hours (4 PM–8 PM EST)
 *      → daily_values row for the NEXT US weekday (after-hours previews the next open)
 *
 * Session phase is detected by comparing current server time (UTC seconds) against
 * the currentTradingPeriod boundaries returned by Yahoo — no timezone conversions needed.
 *
 * @param {object} meta - result.meta from Yahoo chart API
 * @param {number[]} timestamps - result.timestamp candle start Unix seconds
 * @param {number[]} closes - result.indicators.quote[0].close candle closes
 * @returns {{ date, price, change, changePercent, officialClose, previousClose, sessionPhase, sessionDateIst } | null}
 */
function detectForeignStockSession(meta, timestamps, closes) {
  if (!meta || !meta.regularMarketPrice) return null;

  const tp = meta.currentTradingPeriod;
  const regularStart = tp?.regular?.start;
  const regularEnd   = tp?.regular?.end;
  const postEnd      = tp?.post?.end;
  const preStart     = tp?.pre?.start;
  const preEnd       = tp?.pre?.end;

  // Session phase: compare current UTC time against Yahoo's trading period boundaries.
  const nowSec = Math.floor(Date.now() / 1000);
  const inAfterHours = Number.isFinite(regularEnd) && Number.isFinite(postEnd)
    && nowSec >= regularEnd && nowSec <= postEnd;
  const inPreMarket = !inAfterHours
    && Number.isFinite(preStart) && Number.isFinite(preEnd)
    && nowSec >= preStart && nowSec < preEnd;

  // Use exchange session date semantics from provider timestamps.
  // We intentionally avoid IST date conversion for storage date attribution.
  const sessionDateIst = regularStart ? utcDateFromUnixSeconds(regularStart) : null;
  if (!sessionDateIst) return null;

  // After-hours data belongs to the NEXT trading session's daily_values row.
  const providerDate = inAfterHours ? nextUsWeekday(sessionDateIst) : sessionDateIst;

  // Best available price for the current session phase.
  const prevClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
  const postPrice = Number(meta.postMarketPrice);
  const prePrice  = Number(meta.preMarketPrice);
  const preTime   = Number(meta.preMarketTime);
  const regTime   = Number(meta.regularMarketTime);

  let price, sessionPhase;
  if (inAfterHours && Number.isFinite(postPrice) && postPrice > 0) {
    price = postPrice;
    sessionPhase = 'post';
  } else if (inPreMarket && Number.isFinite(prePrice) && prePrice > 0 && preTime > regTime) {
    price = prePrice;
    sessionPhase = 'pre';
  } else {
    price = meta.regularMarketPrice;
    sessionPhase = 'regular';
  }

  const change    = price - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

  // officialClose: the regular-session candle close for the session date.
  // Used as the LIVE writeback price for the session date row when in after-hours.
  let officialClose = null;
  if (Array.isArray(timestamps) && Array.isArray(closes)) {
    const points = Math.min(timestamps.length, closes.length);
    for (let i = 0; i < points; i += 1) {
      const pointDate = utcDateFromUnixSeconds(timestamps[i]);
      if (pointDate !== sessionDateIst) continue;
      const c = Number(closes[i]);
      if (!Number.isFinite(c) || c <= 0) continue;
      officialClose = c;
    }
  }

  return {
    price,
    change:          Math.round(change * 100) / 100,
    changePercent:   Math.round(changePct * 100) / 100,
    previousClose:   prevClose,
    officialClose,
    date:            providerDate,   // intended daily_values date
    sessionDateIst,                  // actual US session date (for after-hours writeback)
    sessionPhase,                    // 'pre' | 'regular' | 'post'
  };
}

/**
 * Determine provider date attribution for Indian stocks from observed quote/candle
 * timestamps instead of foreign session metadata.
 *
 * This avoids advancing to the next IST day before a true new-day quote exists.
 *
 * @param {object} meta - result.meta from Yahoo chart API
 * @param {number[]} timestamps - result.timestamp candle start Unix seconds
 * @returns {{ date, price, change, changePercent, officialClose, previousClose, sessionPhase, sessionDateIst } | null}
 */
function detectIndianStockSession(meta, timestamps) {
  if (!meta || !meta.regularMarketPrice) return null;

  let providerDate = null;
  const regularMarketTime = Number(meta.regularMarketTime);
  if (Number.isFinite(regularMarketTime) && regularMarketTime > 0) {
    providerDate = istDateFromUnixSeconds(regularMarketTime);
  }

  if (!providerDate && Array.isArray(timestamps) && timestamps.length > 0) {
    for (let i = timestamps.length - 1; i >= 0; i -= 1) {
      const ts = Number(timestamps[i]);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      providerDate = istDateFromUnixSeconds(ts);
      if (providerDate) break;
    }
  }

  if (!providerDate) return null;

  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const prevCloseRaw = Number(meta.chartPreviousClose ?? meta.previousClose);
  const previousClose = Number.isFinite(prevCloseRaw) && prevCloseRaw > 0
    ? prevCloseRaw
    : price;

  const changeRaw = Number(meta.regularMarketChange);
  const change = Number.isFinite(changeRaw)
    ? changeRaw
    : (price - previousClose);

  const changePercentRaw = Number(meta.regularMarketChangePercent);
  const changePercent = Number.isFinite(changePercentRaw)
    ? changePercentRaw
    : (previousClose > 0 ? (change / previousClose) * 100 : 0);

  return {
    price,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    previousClose,
    officialClose: null,
    date: providerDate,
    sessionDateIst: providerDate,
    sessionPhase: 'regular',
  };
}

/**
 * Check if a date (YYYY-MM-DD) is a weekday (Mon-Fri), used for NSE trading day.
 * @param {string} dateIso - ISO date string (YYYY-MM-DD)
 * @returns {boolean}
 */
function isWeekday(dateIso) {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const dayOfWeek = d.getUTCDay();
  return dayOfWeek >= 1 && dayOfWeek <= 5; // 0=Sun, 1=Mon, ..., 6=Sat
}

/**
 * Check if data for a given date should be marked LIVE or LOCF based on asset type.
 * NSE trades 9:15 AM - 3:30 PM IST (weekdays only).
 * - If NOT a weekday: definitely LOCF (market closed)
 * - If weekday but before 9:15 AM or after 3:30 PM IST: likely LOCF (market hours haven't started or have ended)
 * - If weekday and within 9:15 AM - 3:30 PM IST: could be LIVE
 * 
 * For asset types where API returns date info (e.g. MF), prefer explicit date check over this.
 * 
 * @param {string} dateIso - ISO date string (YYYY-MM-DD)
 * @param {Date} [now] - Current time (defaults to now)
 * @returns {string} - 'LIVE' if likely market is/was open, 'LOCF' if likely market was closed
 */
function getMarketDataSourceForNSE(dateIso, now = new Date()) {
  if (!isWeekday(dateIso)) {
    return 'LOCF'; // Weekend, definitely closed
  }
  
  // Convert now to IST (UTC+5:30)
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const hours = istNow.getUTCHours();
  const minutes = istNow.getUTCMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  const nseOpenIST = 9 * 60 + 15; // 9:15 AM
  const nseCloseIST = 15 * 60 + 30; // 3:30 PM
  
  if (timeInMinutes >= nseOpenIST && timeInMinutes <= nseCloseIST) {
    return 'LIVE';
  } else {
    return 'LOCF';
  }
}

// ─── Mutual Fund NAV from AMFI ────────────────────────────────────────────────

/**
 * Fetch latest NAV for a mutual fund scheme from mfapi.in.
 * Uses date-range filtering (last 10 days) to get current + previous NAV
 * in a single fast request, so day change can be computed like Yahoo does for stocks.
 * @param {string} amfiCode - AMFI scheme code
 * @returns {Promise<{nav: number, date: string, change: number, changePercent: number, schemeName: string}>}
 */
async function fetchMutualFundNAV(amfiCode) {
  return new Promise((resolve, reject) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 10);
    const fmt = d => formatIstDate(d);
    const url = `https://api.mfapi.in/mf/${amfiCode}?startDate=${fmt(start)}&endDate=${fmt(end)}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data && json.data.length > 0) {
            const currentNav = parseFloat(json.data[0].nav);
            const prevNav = json.data.length > 1 ? parseFloat(json.data[1].nav) : null;
            const change = prevNav != null ? currentNav - prevNav : 0;
            const changePercent = prevNav != null && prevNav > 0
              ? (change / prevNav) * 100 : 0;
            resolve({
              nav: currentNav,
              date: normalizeProviderDate(json.data[0].date),
              schemeName: json.meta?.scheme_name || '',
              change: Math.round(change * 10000) / 10000,
              changePercent: Math.round(changePercent * 100) / 100,
            });
          } else {
            reject(new Error(`No NAV data for scheme ${amfiCode}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse NAV for ${amfiCode}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Search mutual funds by name
 * @param {string} query
 * @returns {Promise<Array<{schemeCode: string, schemeName: string}>>}
 */
async function searchMutualFunds(query) {
  return new Promise((resolve, reject) => {
    const url = `https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          resolve(results.slice(0, 20).map(r => ({
            schemeCode: String(r.schemeCode),
            schemeName: r.schemeName,
          })));
        } catch (e) {
          reject(new Error(`Failed to search mutual funds: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch historical NAV for a mutual fund
 * @param {string} amfiCode
 * @returns {Promise<Array<{date: string, nav: number}>>}
 */
async function fetchMutualFundHistory(amfiCode) {
  return new Promise((resolve, reject) => {
    const url = `https://api.mfapi.in/mf/${amfiCode}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data && json.data.length > 0) {
            const rows = json.data.map(d => ({
              date: d.date,
              nav: parseFloat(d.nav),
            }));
            resolve(rows);
          } else {
            reject(new Error(`No history for scheme ${amfiCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Stock Prices from Yahoo Finance ──────────────────────────────────────────

let yahooFinance = null;

async function getYahooFinance() {
  if (!yahooFinance) {
    const YahooFinance = await import('yahoo-finance2').then(m => m.default);
    yahooFinance = new YahooFinance();
  }
  return yahooFinance;
}

/**
 * Fetch current stock price using Yahoo Finance v8 API (direct HTTP, no crumb needed).
 * Falls back to yahoo-finance2 library if direct approach fails.
 * @param {string} symbol - Ticker symbol (e.g., 'RELIANCE.NS' for NSE, 'AAPL' for US)
 * @param {Object} [options]
 * @param {'1d'|'1m'} [options.interval='1d'] - Interval for chart lane. 1d for close lane, 1m for phase lane.
 * @returns {Promise<{price: number, currency: string, name: string, change: number, changePercent: number, officialClose?: number|null}>}
 */
async function fetchStockPrice(symbol, options = {}) {
  // Try direct Yahoo Finance API first (more reliable, no crumb needed)
  try {
    return await fetchStockPriceDirect(symbol, options);
  } catch (directErr) {
    // Fall back to yahoo-finance2 library
    try {
      const yf = await getYahooFinance();
      const quote = await yf.quote(symbol);
      return {
        price: quote.regularMarketPrice,
        currency: quote.currency,
        name: quote.shortName || quote.longName || symbol,
        change: quote.regularMarketChange || 0,
        changePercent: quote.regularMarketChangePercent || 0,
        previousClose: quote.regularMarketPreviousClose,
        officialClose: null,
        sessionPhase: 'regular',
        sessionDateIst: (() => {
          // Use session start for correct US date; fall back to UTC of close (safe for US markets)
          const tp = quote.currentTradingPeriod;
          const s = tp?.regular?.start;
          return s ? utcDateFromUnixSeconds(s) : utcDateFromUnixSeconds(quote.regularMarketTime);
        })(),
        date: (() => {
          const tp = quote.currentTradingPeriod;
          const regularEnd = tp?.regular?.end;
          const postEnd = tp?.post?.end;
          const nowSec = Math.floor(Date.now() / 1000);
          const sessionStart = tp?.regular?.start;
          const sessionDateIst = sessionStart
            ? utcDateFromUnixSeconds(sessionStart)
            : utcDateFromUnixSeconds(quote.regularMarketTime);
          const inAH = Number.isFinite(regularEnd) && Number.isFinite(postEnd)
            && nowSec >= regularEnd && nowSec <= postEnd;
          return (inAH && sessionDateIst) ? nextUsWeekday(sessionDateIst) : sessionDateIst;
        })(),
      };
    } catch (libErr) {
      throw new Error(`Failed to fetch price for ${symbol}: ${directErr.message}`);
    }
  }
}

/**
 * Fetch stock price via Yahoo Finance v8 chart API (no crumb/auth needed).
 */
function fetchStockPriceDirect(symbol, options = {}) {
  return new Promise((resolve, reject) => {
    const interval = options.interval === '1m' ? '1m' : '1d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=${interval}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          const meta = result?.meta;
          if (meta && meta.regularMarketPrice) {
            const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
            const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
              ? result.indicators.quote[0].close
              : [];
            const instrumentType = inferStockInstrumentType(symbol);
            const sessionInfo = instrumentType === 'INDIAN_STOCK'
              ? detectIndianStockSession(meta, timestamps)
              : detectForeignStockSession(meta, timestamps, closes);
            if (!sessionInfo) {
              reject(new Error(`No price data for ${symbol}`));
              return;
            }
            resolve({
              price:          sessionInfo.price,
              currency:       meta.currency || 'USD',
              name:           meta.shortName || meta.longName || symbol,
              change:         sessionInfo.change,
              changePercent:  sessionInfo.changePercent,
              previousClose:  sessionInfo.previousClose,
              officialClose:  sessionInfo.officialClose,
              date:           sessionInfo.date,
              sessionDateIst: sessionInfo.sessionDateIst,
              sessionPhase:   sessionInfo.sessionPhase,
            });
          } else {
            reject(new Error(`No price data for ${symbol}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse chart for ${symbol}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch stock price history
 * @param {string} symbol
 * @param {string} period - '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'
 */
async function fetchStockHistory(symbol, period = '1y') {
  const instrumentType = inferStockInstrumentType(symbol);
  const periodStart = isoDate(getStartDate(period));
  const today = isoDate(new Date());
  const cached = getSeries(instrumentType, symbol, periodStart, today);
  if (cached.length > 0) {
    const latestCachedDate = cached[cached.length - 1].date;
    if (latestCachedDate >= addDaysIso(today, -1)) {
      return cached
        .filter((q) => q.close != null)
        .map((q) => ({ date: q.date, price: Number(q.close) }));
    }
  }

  try {
    const yf = await getYahooFinance();
    const result = await yf.chart(symbol, { period1: getStartDate(period), period2: new Date() });
    if (result.quotes) {
      const rows = result.quotes
        .filter(q => q.close != null)
        .map(q => ({
          date: formatIstDate(new Date(q.date)),
          price: q.close,
        }));
      upsertPriceSeries(
        instrumentType,
        symbol,
        rows.map((r) => ({ date: r.date, close: r.price, source: 'YAHOO' })),
        'YAHOO'
      );
      return rows;
    }
    return [];
  } catch (e) {
    throw new Error(`Failed to fetch history for ${symbol}: ${e.message}`);
  }
}

/**
 * Fetch historical stock close for a specific date.
 * Uses Yahoo chart API over a narrow window and returns the nearest close on or before target date.
 * @param {string} symbol
 * @param {string} date - ISO date YYYY-MM-DD
 * @returns {Promise<number>}
 */
async function fetchHistoricalStockPrice(symbol, date) {
  if (!symbol || !date) throw new Error('symbol and date are required');

  const instrumentType = inferStockInstrumentType(symbol);
  const resolveCachedPrice = (row) => {
    if (!row) return null;
    if (instrumentType === 'INDIAN_STOCK') {
      const adjusted = row.adj_close ?? row.adjClose;
      if (adjusted != null) return Number(adjusted);
    }
    if (row.close != null) return Number(row.close);
    return null;
  };
  const cached = getNearestOnOrBefore(instrumentType, symbol, date);
  const cachedPrice = resolveCachedPrice(cached);
  if (cachedPrice != null) return cachedPrice;

  const target = new Date(date);
  const from = new Date(target);
  from.setDate(from.getDate() - 7);
  const to = new Date(target);
  to.setDate(to.getDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) {
            reject(new Error(`No Yahoo data for ${symbol}`));
            return;
          }

          const timestamps = result.timestamp || [];
          const closes = result.indicators?.quote?.[0]?.close || [];
          const isoTarget = date.split('T')[0];

          let bestPrice = null;
          let bestDate = null;
          const parsedRows = [];
          for (let i = 0; i < timestamps.length; i += 1) {
            const close = closes[i];
            if (close == null) continue;
            const pointDate = istDateFromUnixSeconds(timestamps[i]);
            if (!pointDate) continue;
            parsedRows.push({ date: pointDate, close, source: 'YAHOO' });
            if (pointDate <= isoTarget && (!bestDate || pointDate > bestDate)) {
              bestDate = pointDate;
              bestPrice = close;
            }
          }

          if (parsedRows.length > 0) {
            upsertPriceSeries(instrumentType, symbol, parsedRows, 'YAHOO');
          }

          const refreshed = getNearestOnOrBefore(instrumentType, symbol, date);
          const refreshedPrice = resolveCachedPrice(refreshed);
          if (refreshedPrice != null) resolve(refreshedPrice);
          else if (bestPrice != null) resolve(bestPrice);
          else reject(new Error(`No historical close found for ${symbol} on or before ${date}`));
        } catch (e) {
          reject(new Error(`Failed to parse historical chart for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch historical OHLC (Open, High, Low, Close) data for a given date.
 * Returns the OHLC for the exact date or the nearest trading date on or before.
 * @param {string} symbol - Stock ticker
 * @param {string} date - Date as YYYY-MM-DD
 * @returns {Promise<{open: number, high: number, low: number, close: number}|null>}
 */
async function fetchHistoricalOHLC(symbol, date) {
  if (!symbol || !date) throw new Error('symbol and date are required');

  const instrumentType = inferStockInstrumentType(symbol);
  const cached = getNearestOnOrBefore(instrumentType, symbol, date);
  if (cached && cached.open != null && cached.high != null && cached.low != null && cached.close != null) {
    return {
      open: Number(cached.open),
      high: Number(cached.high),
      low: Number(cached.low),
      close: Number(cached.close),
    };
  }

  const target = new Date(date);
  const from = new Date(target);
  from.setDate(from.getDate() - 7);
  const to = new Date(target);
  to.setDate(to.getDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) {
            reject(new Error(`No Yahoo data for ${symbol}`));
            return;
          }

          const timestamps = result.timestamp || [];
          const quote = result.indicators?.quote?.[0] || {};
          const opens = quote.open || [];
          const highs = quote.high || [];
          const lows = quote.low || [];
          const closes = quote.close || [];
          const isoTarget = date.split('T')[0];

          let bestOHLC = null;
          let bestDate = null;
          const parsedRows = [];
          for (let i = 0; i < timestamps.length; i += 1) {
            const o = opens[i];
            const h = highs[i];
            const l = lows[i];
            const c = closes[i];
            if (o == null || h == null || l == null || c == null) continue;

            const pointDate = istDateFromUnixSeconds(timestamps[i]);
            if (!pointDate) continue;
            parsedRows.push({ date: pointDate, open: o, high: h, low: l, close: c, source: 'YAHOO' });
            if (pointDate <= isoTarget && (!bestDate || pointDate > bestDate)) {
              bestDate = pointDate;
              bestOHLC = { open: o, high: h, low: l, close: c };
            }
          }

          if (parsedRows.length > 0) {
            upsertPriceSeries(instrumentType, symbol, parsedRows, 'YAHOO');
          }

          if (bestOHLC) resolve(bestOHLC);
          else resolve(null);
        } catch (e) {
          reject(new Error(`Failed to parse historical OHLC for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch historical OHLC rows for an inclusive date range in a single provider call.
 * @param {string} symbol - Stock ticker
 * @param {string} fromDate - Start date as YYYY-MM-DD
 * @param {string} toDate - End date as YYYY-MM-DD
 * @returns {Promise<Array<{date: string, open: number, high: number, low: number, close: number}>>}
 */
async function fetchHistoricalOHLCRange(symbol, fromDate, toDate) {
  if (!symbol || !fromDate || !toDate) {
    throw new Error('symbol, fromDate, and toDate are required');
  }

  const start = String(fromDate).split('T')[0];
  const end = String(toDate).split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(`Invalid stock date range ${fromDate}..${toDate}`);
  }
  if (start > end) {
    throw new Error(`Invalid stock date range ordering ${start}..${end}`);
  }

  const instrumentType = inferStockInstrumentType(symbol);
  const cachedBefore = getSeries(instrumentType, symbol, start, end)
    .filter((row) => row.open != null && row.high != null && row.low != null && row.close != null)
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }));

  const from = new Date(`${start}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(`${end}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

  try {
    await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const result = json.chart?.result?.[0];
            if (!result) {
              reject(new Error(`No Yahoo data for ${symbol}`));
              return;
            }

            const timestamps = result.timestamp || [];
            const quote = result.indicators?.quote?.[0] || {};
            const opens = quote.open || [];
            const highs = quote.high || [];
            const lows = quote.low || [];
            const closes = quote.close || [];

            const parsedRows = [];
            for (let i = 0; i < timestamps.length; i += 1) {
              const o = opens[i];
              const h = highs[i];
              const l = lows[i];
              const c = closes[i];
              if (o == null || h == null || l == null || c == null) continue;

              const pointDate = istDateFromUnixSeconds(timestamps[i]);
              if (!pointDate) continue;
              if (pointDate < start || pointDate > end) continue;
              parsedRows.push({ date: pointDate, open: o, high: h, low: l, close: c, source: 'YAHOO' });
            }

            if (parsedRows.length > 0) {
              upsertPriceSeries(instrumentType, symbol, parsedRows, 'YAHOO');
            }

            resolve();
          } catch (e) {
            reject(new Error(`Failed to parse historical OHLC range for ${symbol}: ${e.message}`));
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  } catch (error) {
    if (cachedBefore.length > 0) return cachedBefore;
    throw error;
  }

  const refreshed = getSeries(instrumentType, symbol, start, end)
    .filter((row) => row.open != null && row.high != null && row.low != null && row.close != null)
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }));

  return refreshed;
}

/**
 * Fetch USD to INR exchange rate (current)
 */
async function fetchUSDToINR() {
  try {
    // Try direct chart API first
    const data = await fetchStockPriceDirect('USDINR=X');
    return data.price || 83.5;
  } catch (e) {
    try {
      const yf = await getYahooFinance();
      const quote = await yf.quote('USDINR=X');
      return quote.regularMarketPrice || 83.5;
    } catch (e2) {
      console.error('Failed to fetch USD/INR rate:', e.message);
      return 83.5; // fallback
    }
  }
}

/**
 * Fetch historical USD/INR exchange rate for a specific date.
 *
 * Strategy:
 *   1. Try FBIL (Financial Benchmarks India Ltd) — publishes the official RBI
 *      reference rate. The public CSV endpoint returns the rate for a given date.
 *   2. Fall back to Yahoo Finance historical chart for USDINR=X.
 *   3. Fall back to the cached/live rate as a last resort.
 *
 * @param {string} date - ISO date string e.g. '2024-03-15'
 * @returns {Promise<number>} INR per USD
 */
async function fetchHistoricalUSDToINR(date) {
  if (!date) return fetchUSDToINR();

  const exact = getSeries('FX', 'USDINR=X', date, date)
    .find((row) => row?.date === date && row?.close != null);
  if (exact && exact.close != null) return Number(exact.close);

  const nearestCached = getNearestOnOrBefore('FX', 'USDINR=X', date);

  // ── 1. FBIL reference rate ────────────────────────────────────────────────
  try {
    const rate = await _fetchFBILRate(date);
    if (rate && rate > 0) {
      upsertPricePoint({ instrumentType: 'FX', symbol: 'USDINR=X', date, close: rate, source: 'FBIL' });
      return rate;
    }
  } catch (e) {
    console.error(`fetchHistoricalUSDToINR: FBIL fetch failed for ${date}:`, e.message);
  }

  // ── 2. Yahoo Finance historical USDINR=X ──────────────────────────────────
  try {
    const rate = await _fetchYahooHistoricalUSDINR(date);
    if (rate && rate > 0) {
      upsertPricePoint({ instrumentType: 'FX', symbol: 'USDINR=X', date, close: rate, source: 'YAHOO' });
      return rate;
    }
  } catch (e) {
    console.error(`fetchHistoricalUSDToINR: Yahoo fetch failed for ${date}:`, e.message);
  }

  // ── 3. Current rate as fallback ───────────────────────────────────────────
  if (nearestCached && nearestCached.close != null) {
    const locfRate = Number(nearestCached.close);
    if (Number.isFinite(locfRate) && locfRate > 0) {
      upsertPricePoint({ instrumentType: 'FX', symbol: 'USDINR=X', date, close: locfRate, source: 'LOCF' });
      return locfRate;
    }
  }

  console.warn(`fetchHistoricalUSDToINR: could not get rate for ${date}, using current rate`);
  const currentRate = await fetchUSDToINR();
  if (Number.isFinite(Number(currentRate)) && Number(currentRate) > 0) {
    upsertPricePoint({ instrumentType: 'FX', symbol: 'USDINR=X', date, close: Number(currentRate), source: 'YAHOO' });
    return Number(currentRate);
  }

  return currentRate;
}

const fbilMonthlyCache = new Map();

function getYearMonth(dateIso) {
  const [year, month] = String(dateIso).split('-');
  return `${year}-${month}`;
}

function nextMonth(ym) {
  const [yearStr, monthStr] = ym.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function listYearMonths(fromDate, toDate) {
  const out = [];
  let ym = getYearMonth(fromDate);
  const endYm = getYearMonth(toDate);
  while (ym <= endYm) {
    out.push(ym);
    ym = nextMonth(ym);
  }
  return out;
}

function parseFBILMonthlyCsv(csvText) {
  const byDate = new Map();
  const lines = String(csvText || '').trim().split('\n').slice(1);
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const parsedDate = _parseFBILDate((parts[0] || '').trim());
    const rate = parseFloat((parts[1] || '').trim());
    if (!parsedDate || !Number.isFinite(rate) || rate <= 0) continue;
    byDate.set(parsedDate, rate);
  }
  return byDate;
}

async function fetchFBILMonthlyRates(yearMonth) {
  if (fbilMonthlyCache.has(yearMonth)) {
    return fbilMonthlyCache.get(yearMonth);
  }

  const [year, month] = yearMonth.split('-');
  const url = `https://fbil.org.in/FBIL_Data/upload/Historical_Data/FBIL-USD-INR-${year}-${month}.csv`;

  const promise = new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`FBIL returned ${res.statusCode} for ${yearMonth}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(parseFBILMonthlyCsv(data));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });

  fbilMonthlyCache.set(yearMonth, promise);
  return promise;
}

async function fetchHistoricalUSDToINRRange(fromDate, toDate) {
  const start = String(fromDate || '').split('T')[0];
  const end = String(toDate || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(`Invalid FX date range ${fromDate}..${toDate}`);
  }
  if (start > end) {
    throw new Error(`Invalid FX date range ordering ${start}..${end}`);
  }

  const dates = [];
  let d = start;
  while (d <= end) {
    dates.push(d);
    d = addDaysIso(d, 1);
  }

  const monthRates = new Map();
  const months = listYearMonths(start, end);
  for (const ym of months) {
    try {
      const m = await fetchFBILMonthlyRates(ym);
      monthRates.set(ym, m);
    } catch (e) {
      console.error(`fetchHistoricalUSDToINRRange: FBIL monthly fetch failed for ${ym}:`, e.message);
    }
  }

  let successfulDays = 0;
  let fallbackDays = 0;

  for (const day of dates) {
    const exact = getSeries('FX', 'USDINR=X', day, day)
      .find((row) => row?.date === day && row?.close != null);
    if (exact && exact.close != null) {
      successfulDays += 1;
      continue;
    }

    const ym = getYearMonth(day);
    const rates = monthRates.get(ym);
    if (rates && rates.size > 0) {
      let bestDate = null;
      let bestRate = null;
      for (const [rateDate, rate] of rates.entries()) {
        if (rateDate <= day && (!bestDate || rateDate > bestDate)) {
          bestDate = rateDate;
          bestRate = rate;
        }
      }
      if (bestRate && bestRate > 0) {
        upsertPricePoint({ instrumentType: 'FX', symbol: 'USDINR=X', date: day, close: bestRate, source: 'FBIL' });
        successfulDays += 1;
        continue;
      }
    }

    try {
      await fetchHistoricalUSDToINR(day);
      successfulDays += 1;
      fallbackDays += 1;
    } catch (e) {
      console.error(`fetchHistoricalUSDToINRRange: fallback failed for ${day}:`, e.message);
    }
  }

  return {
    attemptedDays: dates.length,
    successfulDays,
    fallbackDays,
    monthCalls: months.length,
  };
}

/**
 * Fetch FBIL USD/INR reference rate for a given date.
 * FBIL publishes rates at: https://fbil.org.in/FBIL_Data/upload/ReferenceRatesFBIL.csv
 * The CSV format: Date,USD/INR,...
 * Date format in the file: DD-Mmm-YYYY (e.g. 15-Mar-2024)
 */
function _fetchFBILRate(date) {
  const targetDate = new Date(date);
  // FBIL CSV: we fetch the "archive" endpoint which serves a monthly CSV
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const url = `https://fbil.org.in/FBIL_Data/upload/Historical_Data/FBIL-USD-INR-${year}-${month}.csv`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`FBIL returned ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Lines: Date,USD/INR,... — skip header
          const lines = data.trim().split('\n').slice(1);
          const isoTarget = date.split('T')[0]; // YYYY-MM-DD

          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length < 2) continue;
            // FBIL date format is DD-Mon-YYYY (e.g. 15-Mar-2024) or DD/MM/YYYY
            const rawDate = parts[0].trim();
            const parsed = _parseFBILDate(rawDate);
            if (parsed === isoTarget) {
              const rate = parseFloat(parts[1].trim());
              if (!isNaN(rate) && rate > 0) {
                resolve(rate);
                return;
              }
            }
          }
          // If exact date not found (weekend/holiday), try nearest earlier date
          const sortedRates = [];
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length < 2) continue;
            const parsed = _parseFBILDate(parts[0].trim());
            const rate = parseFloat(parts[1].trim());
            if (parsed && !isNaN(rate) && rate > 0 && parsed <= isoTarget) {
              sortedRates.push({ date: parsed, rate });
            }
          }
          if (sortedRates.length > 0) {
            sortedRates.sort((a, b) => b.date.localeCompare(a.date));
            resolve(sortedRates[0].rate);
          } else {
            reject(new Error('No matching rate in FBIL CSV'));
          }
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function _parseFBILDate(raw) {
  // Try DD-Mon-YYYY (15-Mar-2024) → YYYY-MM-DD
  const m1 = raw.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (m1) {
    const months = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
    const mon = months[m1[2]];
    if (mon) return `${m1[3]}-${mon}-${m1[1]}`;
  }
  // Try DD/MM/YYYY
  const m2 = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return null;
}

/**
 * Fetch historical USDINR rate from Yahoo Finance for a specific date.
 * Uses the v8 chart API with a narrow period around the target date.
 */
async function _fetchYahooHistoricalUSDINR(date) {
  const target = new Date(date);
  // Fetch a ±5 day window to account for weekends/holidays
  const from = new Date(target);
  from.setDate(from.getDate() - 5);
  const to = new Date(target);
  to.setDate(to.getDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X?period1=${p1}&period2=${p2}&interval=1d`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) { reject(new Error('No Yahoo data')); return; }

          const timestamps = result.timestamp || [];
          const closes = result.indicators?.quote?.[0]?.close || [];
          const isoTarget = date.split('T')[0];

          // Find the closest date ≤ target
          let bestRate = null;
          let bestDate = null;
          for (let i = 0; i < timestamps.length; i++) {
            const d = istDateFromUnixSeconds(timestamps[i]);
            if (!d) continue;
            if (d <= isoTarget && closes[i] != null) {
              if (!bestDate || d > bestDate) {
                bestDate = d;
                bestRate = closes[i];
              }
            }
          }
          if (bestRate) resolve(bestRate);
          else reject(new Error('No rate found in Yahoo data'));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── PPF/PF Calculation ───────────────────────────────────────────────────────

/**
 * Calculate PPF/PF current value based on contributions and interest rate
 * @param {Array} transactions - Array of {date, amount} deposits
 * @param {number} annualRate - Annual interest rate (e.g., 7.1)
 * @returns {number} Current value
 */
function calculatePPFValue(transactions, annualRateOrHistory) {
  const now = new Date();

  // Support both single rate (backward compat) and rate history array
  if (typeof annualRateOrHistory === 'number') {
    const rate = annualRateOrHistory / 100;
    let totalValue = 0;
    for (const txn of transactions) {
      const depositDate = new Date(txn.date);
      const yearsHeld = (now - depositDate) / (365.25 * 24 * 60 * 60 * 1000);
      totalValue += txn.amount * Math.pow(1 + rate, yearsHeld);
    }
    return Math.round(totalValue * 100) / 100;
  }

  // Historical rate mode: annualRateOrHistory is an array of { rate, effective_from, effective_to }
  // sorted by effective_from ascending
  const rates = annualRateOrHistory;
  if (!rates || rates.length === 0) return 0;

  let totalValue = 0;

  for (const txn of transactions) {
    const depositDate = new Date(txn.date);
    if (depositDate >= now) continue;

    // Compound across rate periods
    let value = txn.amount;
    let periodStart = depositDate;

    for (const r of rates) {
      const rateStart = new Date(r.effective_from);
      const rateEnd = r.effective_to ? new Date(r.effective_to) : now;

      // Find overlap between [periodStart, now] and [rateStart, rateEnd]
      const overlapStart = periodStart > rateStart ? periodStart : rateStart;
      const overlapEnd = now < rateEnd ? now : rateEnd;

      if (overlapStart >= overlapEnd) continue;
      if (overlapStart >= now) break;

      const yearsInPeriod = (overlapEnd - overlapStart) / (365.25 * 24 * 60 * 60 * 1000);
      value *= Math.pow(1 + r.rate / 100, yearsInPeriod);
    }

    totalValue += value;
  }

  return Math.round(totalValue * 100) / 100;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStartDate(period) {
  const now = new Date();
  switch (period) {
    case '1d': return new Date(now.setDate(now.getDate() - 2));
    case '5d': return new Date(now.setDate(now.getDate() - 7));
    case '1mo': return new Date(now.setMonth(now.getMonth() - 1));
    case '3mo': return new Date(now.setMonth(now.getMonth() - 3));
    case '6mo': return new Date(now.setMonth(now.getMonth() - 6));
    case '1y': return new Date(now.setFullYear(now.getFullYear() - 1));
    case '2y': return new Date(now.setFullYear(now.getFullYear() - 2));
    case '5y': return new Date(now.setFullYear(now.getFullYear() - 5));
    default: return new Date(now.setFullYear(now.getFullYear() - 1));
  }
}

/**
 * Get Indian stock ticker for Yahoo Finance
 * @param {string} symbol - NSE symbol (e.g., 'RELIANCE')
 * @returns {string} Yahoo Finance ticker (e.g., 'RELIANCE.NS')
 */
function toNSETicker(symbol) {
  if (symbol.endsWith('.NS') || symbol.endsWith('.BO')) return symbol;
  return `${symbol}.NS`;
}

/**
 * Search stocks/ETFs by name or ticker using Yahoo Finance search API.
 * @param {string} query - Search term (e.g., 'ICICI', 'Nifty ETF')
 * @param {string} [market] - Optional: 'NSE' to filter Indian stocks only
 * @returns {Promise<Array<{symbol: string, name: string, exchange: string, type: string}>>}
 */
function searchStocks(query, market) {
  return new Promise((resolve) => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.quotes || [])
            .filter(q => ['EQUITY', 'ETF'].includes(q.quoteType))
            .filter(q => !market || market !== 'NSE' || q.symbol?.endsWith('.NS') || q.symbol?.endsWith('.BO'))
            // Filter out junk symbols (0P... are MF codes, not stocks/ETFs)
            .filter(q => !/^0P/.test(q.symbol))
            .map(q => ({
              symbol: q.symbol,
              name: q.longname || q.shortname || q.symbol,
              exchange: q.exchDisp || q.exchange || '',
              type: q.quoteType,
            }));
          resolve(results);
        } catch (e) {
          console.warn(`Stock search failed for "${query}":`, e.message);
          resolve([]);
        }
      });
      res.on('error', (err) => {
        console.error(`Stock search request stream error for "${query}":`, err?.message || err);
        resolve([]);
      });
    }).on('error', (err) => {
      console.error(`Stock search request failed for "${query}":`, err?.message || err);
      resolve([]);
    });
  });
}

/**
 * Look up NSE/BSE ticker symbol from an ISIN using Yahoo Finance search API.
 * @param {string} isin - ISIN code (e.g., 'INE296A01032')
 * @returns {Promise<string|null>} Full Yahoo Finance symbol (e.g., 'BAJFINANCE.NS', 'NSDL.BO') or null
 */
async function lookupTickerByISIN(isin) {
  return new Promise((resolve) => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=5&newsCount=0`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.quotes && json.quotes.length > 0) {
            // Prefer NSE (.NS) over BSE (.BO) over others
            const nseQuote = json.quotes.find(q => q.symbol?.endsWith('.NS') && q.quoteType === 'EQUITY');
            const bseQuote = json.quotes.find(q => q.symbol?.endsWith('.BO') && q.quoteType === 'EQUITY');
            const anyEquity = json.quotes.find(q => q.quoteType === 'EQUITY');
            const match = nseQuote || bseQuote || anyEquity;
            if (match) {
              // Return the full symbol with exchange suffix for direct use
              resolve(match.symbol);
              return;
            }
          }
          resolve(null);
        } catch (e) {
          console.warn(`Failed to lookup ticker for ISIN ${isin}:`, e.message);
          resolve(null);
        }
      });
      res.on('error', (err) => {
        console.error(`ISIN lookup request stream error for ${isin}:`, err?.message || err);
        resolve(null);
      });
    }).on('error', (err) => {
      console.error(`ISIN lookup request failed for ${isin}:`, err?.message || err);
      resolve(null);
    });
  });
}

/**
 * Fetch corporate actions (dividends & splits) for a stock in a given year.
 * - FOREIGN_STOCK: NASDAQ dividends (record/payment dates), Yahoo splits
 * - Others: Yahoo dividends + splits
 * @param {string} symbol - Yahoo Finance symbol (e.g., 'RELIANCE.NS')
 * @param {number} year - Calendar year to fetch actions for
 * @param {{assetType?: string}} [options]
 * @returns {Promise<{dividends: Array, splits: Array, warnings?: Array<string>}>}
 */
async function fetchCorporateActions(symbol, year, options = {}) {
  const assetType = options.assetType || null;
  const period1 = Math.floor(new Date(`${year}-01-01`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${year}-12-31T23:59:59`).getTime() / 1000);

  const { dividends: yahooDividends, splits } = await _fetchChartEvents(symbol, period1, period2);

  if (assetType === 'FOREIGN_STOCK') {
    const { dividends, warnings } = await _fetchNasdaqDividends(symbol, year);
    return { dividends, splits, warnings };
  }

  // Yahoo Finance returns split-adjusted dividend amounts for historical data.
  // If a stock paid ₹10/share and later had a 1:1 bonus, Yahoo reports ₹5/share.
  // We reverse this by fetching all splits from the dividend year to today and
  // computing a cumulative adjustment factor for each dividend.
  const dividends = yahooDividends;
  const currentYear = new Date().getFullYear();
  if (dividends.length > 0 && year < currentYear) {
    // Fetch splits from start of the requested year to today
    const splitStart = period1;
    const splitEnd = Math.floor(Date.now() / 1000);
    const futureSplitData = await _fetchChartEvents(symbol, splitStart, splitEnd, true);
    const allSplits = futureSplitData.splits;

    for (const div of dividends) {
      // Multiply by the ratio of every split that occurred AFTER this dividend date
      let adjustmentFactor = 1;
      for (const s of allSplits) {
        if (s.date > div.date) {
          adjustmentFactor *= s.numerator / s.denominator;
        }
      }
      if (adjustmentFactor !== 1) {
        div.amount = Math.round(div.amount * adjustmentFactor * 10000) / 10000;
      }
    }
  }

  return { dividends, splits, warnings: [] };
}

/**
 * Fetch dividend events in one range call.
 * - FOREIGN_STOCK: NASDAQ once, filtered by payment date range
 * - Others: Yahoo chart dividend events over the exact range
 * @param {string} symbol
 * @param {string} fromDate - ISO date YYYY-MM-DD
 * @param {string} toDate - ISO date YYYY-MM-DD
 * @param {{assetType?: string}} [options]
 * @returns {Promise<{dividends: Array, warnings?: Array<string>}>}
 */
async function fetchDividendEventsForRange(symbol, fromDate, toDate, options = {}) {
  const assetType = options.assetType || null;
  const startIso = String(fromDate || '').split('T')[0];
  const endIso = String(toDate || '').split('T')[0];
  if (!symbol || !startIso || !endIso || startIso > endIso) {
    return { dividends: [], warnings: [] };
  }

  if (assetType === 'FOREIGN_STOCK') {
    const { dividends, warnings } = await _fetchNasdaqDividendsAll(symbol);
    const filtered = dividends.filter((d) => {
      const paymentDate = d?.payment_date || d?.date;
      return paymentDate && paymentDate >= startIso && paymentDate <= endIso;
    });
    return { dividends: filtered, warnings };
  }

  const period1 = Math.floor(new Date(`${startIso}T00:00:00.000Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${endIso}T23:59:59.000Z`).getTime() / 1000);
  const { dividends } = await _fetchChartEvents(symbol, period1, period2);
  return {
    dividends: (dividends || []).filter((d) => d?.date && d.date >= startIso && d.date <= endIso),
    warnings: [],
  };
}

/**
 * Fetch foreign-stock dividends from NASDAQ with record/payment dates.
 * Returns normalized rows with:
 * - date: payment date (for transaction posting)
 * - record_date: date used for entitlement units
 * - payment_date: payment date
 * - amount: dividend cash amount per share
 */
function _fetchNasdaqDividends(symbol, year) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/dividends?assetclass=stocks`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`NASDAQ dividends API returned ${res.statusCode} for ${symbol}`));
            return;
          }

          const json = JSON.parse(data);
          const rows = json?.data?.dividends?.rows;
          if (!Array.isArray(rows)) {
            reject(new Error(`NASDAQ dividends data missing for ${symbol}`));
            return;
          }

          const dividends = [];
          const warnings = [];
          for (const row of rows) {
            const amount = _parseCurrencyAmount(row?.amount);
            const exDate = _parseNasdaqDate(row?.exOrEffDate);
            const recordDate = _parseNasdaqDate(row?.recordDate || row?.exOrEffDate);
            const paymentDate = _parseNasdaqDate(row?.paymentDate);
            const rowId = `ex=${row?.exOrEffDate || 'NA'}, record=${row?.recordDate || 'NA'}, pay=${row?.paymentDate || 'NA'}, amount=${row?.amount || 'NA'}`;
            const rowYears = [paymentDate, recordDate, exDate]
              .filter(Boolean)
              .map(d => Number(d.slice(0, 4)));
            const isRelevantYear = rowYears.includes(year);

            if (!(amount > 0)) {
              if (isRelevantYear) {
                warnings.push(`NASDAQ dividend row ignored due to non-cash/invalid amount (${rowId})`);
              }
              continue;
            }
            if (!paymentDate || !recordDate) {
              if (isRelevantYear) {
                warnings.push(`NASDAQ dividend row missing payment/record date (${rowId})`);
              }
              continue;
            }

            const paymentYear = Number(paymentDate.slice(0, 4));
            if (paymentYear !== year) continue;

            dividends.push({
              date: paymentDate,
              amount,
              record_date: recordDate,
              payment_date: paymentDate,
            });
          }

          if (dividends.length === 0 && warnings.length === 0) {
            warnings.push(`No NASDAQ dividend rows found for ${symbol} in ${year}`);
          }

          dividends.sort((a, b) => a.date.localeCompare(b.date));
          resolve({ dividends, warnings });
        } catch (e) {
          reject(new Error(`Failed to parse NASDAQ dividends for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function _fetchNasdaqDividendsAll(symbol) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/dividends?assetclass=stocks`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`NASDAQ dividends API returned ${res.statusCode} for ${symbol}`));
            return;
          }

          const json = JSON.parse(data);
          const rows = json?.data?.dividends?.rows;
          if (!Array.isArray(rows)) {
            reject(new Error(`NASDAQ dividends data missing for ${symbol}`));
            return;
          }

          const dividends = [];
          const warnings = [];
          for (const row of rows) {
            const amount = _parseCurrencyAmount(row?.amount);
            const exDate = _parseNasdaqDate(row?.exOrEffDate);
            const recordDate = _parseNasdaqDate(row?.recordDate || row?.exOrEffDate);
            const paymentDate = _parseNasdaqDate(row?.paymentDate);
            const rowId = `ex=${row?.exOrEffDate || 'NA'}, record=${row?.recordDate || 'NA'}, pay=${row?.paymentDate || 'NA'}, amount=${row?.amount || 'NA'}`;

            if (!(amount > 0)) {
              warnings.push(`NASDAQ dividend row ignored due to non-cash/invalid amount (${rowId})`);
              continue;
            }
            if (!paymentDate || !recordDate) {
              warnings.push(`NASDAQ dividend row missing payment/record date (${rowId})`);
              continue;
            }

            dividends.push({
              date: paymentDate,
              amount,
              record_date: recordDate,
              payment_date: paymentDate,
              ex_date: exDate,
            });
          }

          dividends.sort((a, b) => a.date.localeCompare(b.date));
          resolve({ dividends, warnings });
        } catch (e) {
          reject(new Error(`Failed to parse NASDAQ dividends for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function _parseNasdaqDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function _parseCurrencyAmount(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.-]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Internal helper: fetch dividend and split events from Yahoo Finance v8 chart API.
 * @param {string} symbol
 * @param {number} period1 - Unix timestamp start
 * @param {number} period2 - Unix timestamp end
 * @param {boolean} [splitsOnly] - When true, only request split events (saves bandwidth)
 * @returns {Promise<{dividends: Array, splits: Array}>}
 */
function _fetchChartEvents(symbol, period1, period2, splitsOnly) {
  const events = splitsOnly ? 'split' : 'div%2Csplit';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=${events}`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) {
            resolve({ dividends: [], splits: [] });
            return;
          }

          const evts = result.events || {};
          const dividends = [];
          const splits = [];

          if (evts.dividends) {
            for (const [ts, div] of Object.entries(evts.dividends)) {
              dividends.push({
                date: istDateFromUnixSeconds(parseInt(ts, 10)),
                amount: div.amount,
              });
            }
          }

          if (evts.splits) {
            for (const [ts, split] of Object.entries(evts.splits)) {
              splits.push({
                date: istDateFromUnixSeconds(parseInt(ts, 10)),
                numerator: split.numerator,
                denominator: split.denominator,
              });
            }
          }

          dividends.sort((a, b) => a.date.localeCompare(b.date));
          splits.sort((a, b) => a.date.localeCompare(b.date));

          resolve({ dividends, splits });
        } catch (e) {
          reject(new Error(`Failed to parse corporate actions for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Resolve AMFI Code by ISIN ───────────────────────────────────────────────

/**
 * Download the full AMFI NAV file and find scheme codes for multiple ISINs.
 * The file format has lines like:
 *   SchemeCode;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;SchemeName;NAV;Date
 * @param {string[]} isins - Array of ISIN codes to look up
 * @returns {Promise<Map<string, {schemeCode: string, schemeName: string}>>} Map of ISIN → result
 */
function resolveAmfiCodeByISIN(isins) {
  const isinSet = new Set(Array.isArray(isins) ? isins : [isins]);

  function fetchWithRedirect(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchWithRedirect(res.headers.location).then(resolve, reject);
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  return fetchWithRedirect('https://www.amfiindia.com/spages/NAVAll.txt').then(data => {
    const results = new Map();
    const lines = data.split('\n');
    for (const line of lines) {
      const parts = line.split(';');
      if (parts.length >= 4) {
        const isinGrowth = (parts[1] || '').trim();
        const isinReinvest = (parts[2] || '').trim();
        for (const isin of [isinGrowth, isinReinvest]) {
          if (isin && isinSet.has(isin)) {
            results.set(isin, {
              schemeCode: parts[0].trim(),
              schemeName: parts[3].trim(),
            });
          }
        }
      }
    }
    return results;
  });
}

// ─── SGB Price from NSE historical trade provider ────────────────────────────

/**
 * Fetch SGB price from NSE historical trade provider used by backfill.
 * @param {string} symbol - NSE symbol e.g. 'SGBSEP28VI' or 'SGBJAN29IX'
 * @returns {Promise<{price: number, change: number, changePercent: number, previousClose: number}>}
 */
async function fetchSGBPrice(symbol) {
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) throw new Error('SGB symbol is required');

  const { fetchSGBNseHistoricalRaw } = require('./sgbNseHistorical');

  const toDate = isoDate(new Date());
  const fromDate = addDaysIso(toDate, -10);
  const rows = await fetchSGBNseHistoricalRaw(cleanSymbol, fromDate, toDate);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`No price data from NSE historical trade for ${cleanSymbol}`);
  }

  const validRows = rows
    .filter((row) => row?.date && Number.isFinite(Number(row.close)) && Number(row.close) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (validRows.length === 0) {
    throw new Error(`No valid SGB price rows for ${cleanSymbol}`);
  }

  const latest = validRows[validRows.length - 1];
  const previous = validRows.length > 1 ? validRows[validRows.length - 2] : null;
  const price = Number(latest.close);
  const previousClose = previous ? Number(previous.close) : price;
  const change = price - previousClose;
  const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

  return {
    price,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    previousClose,
    date: normalizeProviderDate(latest.date),
  };
}

// ─── NPS NAV Fetching ─────────────────────────────────────────────────────────

function parseNpsDateToIso(dateStr) {
  const s = String(dateStr || '').trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function fetchNpsJson(pathname) {
  const url = `https://npsnav.in${pathname}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'InvestmentTracker/1.0 (+https://localhost)',
    },
  });
  if (!res.ok) {
    throw new Error(`NPSNAV request failed (${res.status}) for ${pathname}`);
  }
  return res.json();
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch latest NAV for an NPS scheme from npsnav.in.
 * @param {string} schemeName - Name or identifier of NPS fund (e.g., "ICICI", "HDFC", etc.)
 * @param {string} fundCode - NPS scheme code (e.g., SM008001)
 * @param {number} lastPrice - Previous known NAV for day-change fallback
 * @returns {Promise<{nav: number, date: string, change: number, changePercent: number, schemeName: string}>}
 */
async function fetchNPSNAV(schemeName, fundCode, lastPrice) {
  const code = String(fundCode || '').trim().toUpperCase();
  if (!code) {
    throw new Error(`Missing nps_fund_code for ${schemeName || 'NPS investment'}`);
  }

  // Use detailed endpoint when available so we can preserve API-provided 1D change.
  const detailed = await fetchNpsJson(`/api/detailed/${encodeURIComponent(code)}`);
  const nav = safeNum(detailed?.NAV);
  const oneDay = safeNum(detailed?.['1D']);
  const updatedIso = parseNpsDateToIso(detailed?.['Last Updated']);

  if (nav == null || nav <= 0) {
    throw new Error(`Invalid NAV response for ${code}`);
  }

  let change = oneDay;
  if (change == null) {
    const prev = safeNum(lastPrice);
    change = prev != null ? nav - prev : 0;
  }
  const prevBase = nav - change;
  const changePercent = prevBase > 0 ? (change / prevBase) * 100 : 0;

  return {
    nav,
    date: updatedIso,
    change: Math.round(change * 10000) / 10000,
    changePercent: Math.round(changePercent * 100) / 100,
    schemeName: detailed?.['Scheme Name'] || schemeName || code,
  };
}

function normalizeNpsHistoryDate(value) {
  return String(value || '').trim().split('T')[0] || null;
}

/**
 * Fetch historical NAV for an NPS fund from npsnav.in.
 * @param {string} npsFundCode - Unique code for the NPS fund
 * @returns {Promise<Array<{date: string, nav: number}>>}
 */
async function fetchNPSHistory(npsFundCode, fromDate = null, toDate = null) {
  const code = String(npsFundCode || '').trim().toUpperCase();
  if (!code) throw new Error('npsFundCode is required');

  const from = normalizeNpsHistoryDate(fromDate) || '1900-01-01';
  const to = normalizeNpsHistoryDate(toDate) || isoDate(new Date());

  const json = await fetchNpsJson(`/api/historical/${encodeURIComponent(code)}`);
  const data = Array.isArray(json?.data) ? json.data : [];
  if (data.length === 0) {
    throw new Error(`No history for NPS fund ${code}`);
  }

  return data
    .map((r) => ({
      date: parseNpsDateToIso(r?.date),
      nav: safeNum(r?.nav),
    }))
    .filter((row) => row.date && row.nav != null && row.nav > 0)
    .filter((row) => row.date >= from && row.date <= to)
    .filter((row) => row.date && row.nav != null && row.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  fetchMutualFundNAV,
  searchMutualFunds,
  fetchMutualFundHistory,
  fetchStockPrice,
  fetchStockHistory,
  fetchHistoricalStockPrice,
  fetchHistoricalOHLC,
  fetchHistoricalOHLCRange,
  fetchCorporateActions,
  fetchDividendEventsForRange,
  fetchUSDToINR,
  fetchHistoricalUSDToINR,
  fetchHistoricalUSDToINRRange,
  calculatePPFValue,
  toNSETicker,
  lookupTickerByISIN,
  searchStocks,
  resolveAmfiCodeByISIN,
  fetchSGBPrice,
  fetchNPSNAV,
  fetchNPSHistory,
  getMarketDataSourceForNSE,
};
