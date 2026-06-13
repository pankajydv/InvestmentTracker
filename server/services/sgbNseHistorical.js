// SGB historical price provider using NSE GetQuoteApi (getHistoricalTradeData endpoint).
// Usage: getSGBNseHistoricalPrices(symbol, fromDate, toDate)
// Returns: Map<YYYY-MM-DD, closePrice>
//
// API: https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi
//   ?functionName=getHistoricalTradeData&symbol=<SYM>&series=GB
//   &fromDate=DD-MM-YYYY&toDate=DD-MM-YYYY&csv=true
//
// The &csv=true parameter returns CSV text with no server-side row cap (vs the JSON
// endpoint which is capped at 70 rows per call). The range is still split into
// 1-year windows as a conservative guard against any server-side date range limits.

const https = require('https');
const { hydrateHistoricalPriceSeries } = require('./marketPriceCache');

const delay = ms => new Promise(r => setTimeout(r, ms));

// NSE session cookie — reuse for 30 minutes to avoid repeated handshakes
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
      },
    }, res => {
      res.resume(); // drain body
      res.on('end', () => {
        _nseCookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        _nseCookieExpiry = Date.now() + 30 * 60 * 1000;
        resolve(_nseCookie);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('NSE cookie fetch timeout')); });
    req.end();
  });
}

// YYYY-MM-DD → DD-MM-YYYY (NSE API date format)
function toNSEDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

// DD-MM-YYYY (from NSE response) → YYYY-MM-DD
function fromNSEDate(nseDate) {
  const parts = String(nseDate || '').trim().split('-');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y || y.length !== 4) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// DD-MMM-YYYY (e.g. 12-Jun-2026) → YYYY-MM-DD
function fromNSETimestamp(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;

  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  const month = months[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

// Single API call for one chunk (≤ 1 year)
// Parse a raw JSON array from the NSE &csv=true endpoint into [{date, close, source}] rows.
// &csv=true returns the same JSON structure as the base endpoint but without the 70-row server cap.
function parseHistoricalTradeDataRows(json) {
  const dataArr = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);

  const rows = [];
  for (const item of dataArr) {
    const rawDate = item.mtimestamp || item.timestamp || item.date || null;
    if (!rawDate) continue;

    const isoDate = /^\d{2}-\d{2}-\d{4}$/.test(rawDate) ? fromNSEDate(rawDate)
      : /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(rawDate) ? fromNSETimestamp(rawDate)
      : /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate
      : null;
    if (!isoDate) continue;

    const price = Number(
      item.chClosingPrice ?? item.chLastTradedPrice ?? item.chPreviousClsPrice ?? item.close ?? item.ltp ?? NaN
    );
    if (!Number.isFinite(price) || price <= 0) continue;

    rows.push({ date: isoDate, close: price, source: 'NSE_HISTORICAL_TRADE' });
  }
  return rows;
}

function summarizeUnexpectedPayload(json) {
  if (json == null) return 'payload=null';
  if (typeof json !== 'object' && !Array.isArray(json)) return `payloadType=${typeof json}`;
  const message = json?.message || json?.error || json?.status;
  const keys = Array.isArray(json) ? `array[${json.length}]` : Object.keys(json).slice(0, 8).join(',');
  if (message) return `message=${String(message)} keys=${keys}`;
  return `keys=${keys || '(none)'}`;
}

async function fetchHistoricalTradeDataChunk(symbol, fromDate, toDate, onLog) {
  const cookie = await getNSECookie();
  const path = (
    '/api/NextApi/apiClient/GetQuoteApi' +
    `?functionName=getHistoricalTradeData` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&series=GB` +
    `&fromDate=${toNSEDate(fromDate)}` +
    `&toDate=${toNSEDate(toDate)}` +
    `&csv=true`
  );

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.nseindia.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://www.nseindia.com/get-quotes/bonds?symbol=${encodeURIComponent(symbol)}`,
        'Cookie': cookie,
      },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${symbol} ${fromDate}→${toDate}`));
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse NSE response for ${symbol}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('NSE request timeout')); });
    req.end();
  });
}

// Split [fromDate, toDate] into ≤1-year chunks, returning [{from, to}]
function buildNseHistoricalYearChunks(fromDate, toDate) {
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  let start = Date.parse(`${fromDate}T00:00:00.000Z`);
  const end   = Date.parse(`${toDate}T00:00:00.000Z`);
  const chunks = [];
  while (start <= end) {
    const chunkEnd = Math.min(start + ONE_YEAR_MS - 86400000, end); // end of chunk (exclusive of next day)
    chunks.push({
      from: new Date(start).toISOString().slice(0, 10),
      to:   new Date(chunkEnd).toISOString().slice(0, 10),
    });
    start = chunkEnd + 86400000; // advance by 1 day past chunk end
  }
  return chunks;
}

async function fetchSGBNseHistoricalRaw(symbol, fromDate, toDate, onLog) {
  const chunks = buildNseHistoricalYearChunks(fromDate, toDate);
  if (onLog) {
    onLog('info', `[SGB] fetchSGBNseHistoricalRaw chunk plan`, {
      symbol,
      totalChunks: chunks.length,
      dateRange: `${fromDate} to ${toDate}`,
      chunks: chunks.map((c, i) => ({ index: i + 1, from: c.from, to: c.to })),
    });
  }

  const allRows = [];
  let chunksWithData = 0;
  let chunksWithoutData = 0;
  let cumulativeRows = 0;

  for (let i = 0; i < chunks.length; i++) {
    const { from, to } = chunks[i];
    const chunkIndex = i + 1;
    const chunkLabel = `${chunkIndex}/${chunks.length}`;

    if (onLog) {
      onLog('info', `[SGB] fetchSGBNseHistoricalRaw chunk ${chunkLabel} fetch started`, {
        symbol,
        chunkIndex,
        totalChunks: chunks.length,
        from,
        to,
      });
      onLog('info', `[SGB] Fetching ${symbol} from Provider from: ${from} to: ${to}`, {
        symbol,
        chunkIndex,
        totalChunks: chunks.length,
        from,
        to,
      });
    }

    try {
      const json = await fetchHistoricalTradeDataChunk(symbol, from, to, onLog);
      const isValidResponse = Array.isArray(json) || Array.isArray(json?.data);
      if (!isValidResponse) {
        const payloadSummary = summarizeUnexpectedPayload(json);
        const err = new Error(`Unexpected NSE response for ${symbol} ${from}→${to} (${payloadSummary})`);
        if (onLog) {
          onLog('error', `[SGB] fetchSGBNseHistoricalRaw chunk ${chunkLabel} returned unexpected payload`, {
            symbol,
            chunkIndex,
            totalChunks: chunks.length,
            from,
            to,
            payloadSummary,
          });
        }
        throw err;
      }

      const rows = parseHistoricalTradeDataRows(json);
      allRows.push(...rows);
      cumulativeRows += rows.length;
      if (rows.length > 0) chunksWithData += 1;
      else chunksWithoutData += 1;

      if (onLog) {
        onLog('info', `[SGB] fetchSGBNseHistoricalRaw chunk ${chunkLabel} fetch completed`, {
          symbol,
          chunkIndex,
          totalChunks: chunks.length,
          from,
          to,
          rowsReturned: rows.length,
          cumulativeRows,
        });
      }

      // Warn if non-first chunk returns zero rows (suspicious)
      if (rows.length === 0 && onLog) {
        onLog(
          i > 0 ? 'warn' : 'info',
          `[SGB] fetchSGBNseHistoricalRaw chunk ${chunkLabel} returned zero rows${i > 0 ? ' (potential provider/cookie issue)' : ''}`,
          {
            symbol,
            chunkIndex,
            totalChunks: chunks.length,
            from,
            to,
            cumulativeRowsBeforeThisChunk: cumulativeRows,
            possibleCause: i > 0
              ? 'NSE cookie expired, session redirected, or provider maintenance'
              : undefined,
          }
        );
      }
    } catch (err) {
      if (onLog) {
        onLog('error', `[SGB] fetchSGBNseHistoricalRaw chunk ${chunkLabel} failed`, {
          symbol,
          chunkIndex,
          totalChunks: chunks.length,
          from,
          to,
          error: err?.message || String(err),
        });
      }
      throw err;
    }

    // Rate-limit between chunks (not needed after last chunk)
    if (i < chunks.length - 1) await delay(500);
  }

  if (onLog) {
    onLog('info', `[SGB] fetchSGBNseHistoricalRaw complete`, {
      symbol,
      chunks: chunks.length,
      chunksWithData,
      chunksWithoutData,
      totalPoints: allRows.length,
      dateRange: `${fromDate} to ${toDate}`,
    });
  }

  // Deduplicate by date (later entries win) and sort ascending
  const byDate = new Map();
  for (const row of allRows) byDate.set(row.date, row);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function getSGBNseHistoricalPrices(symbol, fromDate, toDate, onLog) {
  const rows = await hydrateHistoricalPriceSeries({
    instrumentType: 'SGB',
    symbol,
    fromDate,
    toDate,
    sourceLabel: 'NSE_HISTORICAL_TRADE',
    fetchRange: async (missingFrom, missingTo) => fetchSGBNseHistoricalRaw(symbol, missingFrom, missingTo, onLog),
    mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
  });

  const out = new Map();
  for (const row of rows) {
    if (row?.date && row.close != null) out.set(row.date, Number(row.close));
  }
  return out;
}

module.exports = { getSGBNseHistoricalPrices, fetchSGBNseHistoricalRaw, buildNseHistoricalYearChunks };

