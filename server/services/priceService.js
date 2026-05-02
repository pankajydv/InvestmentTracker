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
    const fmt = d => d.toISOString().split('T')[0];
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
              date: json.data[0].date,
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
            resolve(json.data.map(d => ({
              date: d.date,
              nav: parseFloat(d.nav),
            })));
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
 * @returns {Promise<{price: number, currency: string, name: string, change: number, changePercent: number}>}
 */
async function fetchStockPrice(symbol) {
  // Try direct Yahoo Finance API first (more reliable, no crumb needed)
  try {
    return await fetchStockPriceDirect(symbol);
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
      };
    } catch (libErr) {
      throw new Error(`Failed to fetch price for ${symbol}: ${directErr.message}`);
    }
  }
}

/**
 * Fetch stock price via Yahoo Finance v8 chart API (no crumb/auth needed).
 */
function fetchStockPriceDirect(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const meta = json.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const prevClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
            const change = meta.regularMarketPrice - prevClose;
            const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
            resolve({
              price: meta.regularMarketPrice,
              currency: meta.currency || 'INR',
              name: meta.shortName || meta.longName || symbol,
              change: Math.round(change * 100) / 100,
              changePercent: Math.round(changePct * 100) / 100,
              previousClose: prevClose,
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
  try {
    const yf = await getYahooFinance();
    const result = await yf.chart(symbol, { period1: getStartDate(period), period2: new Date() });
    if (result.quotes) {
      return result.quotes
        .filter(q => q.close != null)
        .map(q => ({
          date: new Date(q.date).toISOString().split('T')[0],
          price: q.close,
        }));
    }
    return [];
  } catch (e) {
    throw new Error(`Failed to fetch history for ${symbol}: ${e.message}`);
  }
}

/**
 * Fetch USD to INR exchange rate
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
      res.on('error', () => resolve([]));
    }).on('error', () => resolve([]));
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
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

/**
 * Fetch corporate actions (dividends & splits) for a stock in a given year.
 * Uses Yahoo Finance v8 chart API with events parameter.
 * @param {string} symbol - Yahoo Finance symbol (e.g., 'RELIANCE.NS')
 * @param {number} year - Calendar year to fetch actions for
 * @returns {Promise<{dividends: Array, splits: Array}>}
 */
async function fetchCorporateActions(symbol, year) {
  const period1 = Math.floor(new Date(`${year}-01-01`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${year}-12-31T23:59:59`).getTime() / 1000);

  const { dividends, splits } = await _fetchChartEvents(symbol, period1, period2);

  // Yahoo Finance returns split-adjusted dividend amounts for historical data.
  // If a stock paid ₹10/share and later had a 1:1 bonus, Yahoo reports ₹5/share.
  // We reverse this by fetching all splits from the dividend year to today and
  // computing a cumulative adjustment factor for each dividend.
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

  return { dividends, splits };
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1mo&events=${events}`;

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
                date: new Date(parseInt(ts) * 1000).toISOString().split('T')[0],
                amount: div.amount,
              });
            }
          }

          if (evts.splits) {
            for (const [ts, split] of Object.entries(evts.splits)) {
              splits.push({
                date: new Date(parseInt(ts) * 1000).toISOString().split('T')[0],
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

// ─── SGB Price from NSE quote-equity API ─────────────────────────────────────

// Reusable NSE session: cache the cookie for 30 minutes
let _nseCookie = null;
let _nseCookieExpiry = 0;

async function getNSECookie() {
  if (_nseCookie && Date.now() < _nseCookieExpiry) return _nseCookie;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.nseindia.com',
      path: '/api/marketStatus',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        _nseCookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        _nseCookieExpiry = Date.now() + 30 * 60 * 1000;
        resolve(_nseCookie);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch SGB price from NSE quote-equity API.
 * @param {string} symbol - NSE symbol e.g. 'SGBSEP28VI' or 'SGBJAN29IX'
 * @returns {Promise<{price: number, change: number, changePercent: number, previousClose: number}>}
 */
async function fetchSGBPrice(symbol) {
  const cookie = await getNSECookie();
  // Small delay to avoid hammering NSE
  await new Promise(r => setTimeout(r, 500));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.nseindia.com',
      path: '/api/quote-equity?symbol=' + encodeURIComponent(symbol),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.nseindia.com/get-quotes/bonds?symbol=' + symbol,
        'Cookie': cookie,
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const pi = json.priceInfo;
          if (!pi || !pi.lastPrice) {
            return reject(new Error(`No price data from NSE for ${symbol}`));
          }
          resolve({
            price: pi.lastPrice,
            change: pi.change || 0,
            changePercent: pi.pChange || 0,
            previousClose: pi.previousClose || pi.close || pi.lastPrice,
          });
        } catch (e) {
          reject(new Error(`Failed to parse NSE response for ${symbol}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  fetchMutualFundNAV,
  searchMutualFunds,
  fetchMutualFundHistory,
  fetchStockPrice,
  fetchStockHistory,
  fetchCorporateActions,
  fetchUSDToINR,
  calculatePPFValue,
  toNSETicker,
  lookupTickerByISIN,
  searchStocks,
  resolveAmfiCodeByISIN,
  fetchSGBPrice,
};
