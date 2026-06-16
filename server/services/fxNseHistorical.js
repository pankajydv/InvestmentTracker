const https = require('https');
const { hydrateHistoricalPriceSeries } = require('./marketPriceCache');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nseCookie = null;
let nseCookieExpiry = 0;

async function getNseCookie() {
  if (nseCookie && Date.now() < nseCookieExpiry) return nseCookie;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.nseindia.com',
      path: '/api/marketStatus',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'application/json',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        nseCookie = (res.headers['set-cookie'] || []).map((value) => value.split(';')[0]).join('; ');
        nseCookieExpiry = Date.now() + 30 * 60 * 1000;
        resolve(nseCookie);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('NSE cookie fetch timeout'));
    });
    req.end();
  });
}

function toNseDate(isoDate) {
  const [year, month, day] = String(isoDate || '').split('-');
  return `${day}-${month}-${year}`;
}

function fromNseTradeDate(value) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  const match = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;

  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const month = months[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
}

function buildNseFxYearChunks(fromDate, toDate) {
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  let start = Date.parse(`${fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${toDate}T00:00:00.000Z`);
  const chunks = [];

  while (start <= end) {
    const chunkEnd = Math.min(start + oneYearMs - 86400000, end);
    chunks.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(chunkEnd).toISOString().slice(0, 10),
    });
    start = chunkEnd + 86400000;
  }

  return chunks;
}

function parseUsdInrCsv(csvText) {
  const lines = String(csvText || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length <= 1) return [];

  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const match = line.match(/^"?([^",]+)"?,\s*([^,\s]+).*/);
    if (!match) continue;

    const date = fromNseTradeDate(match[1]);
    const rate = Number(String(match[2] || '').replace(/^"|"$/g, ''));
    if (!date || !Number.isFinite(rate) || rate <= 0) continue;

    rows.push({ date, close: rate, source: 'NSE_RBI_REFERENCE' });
  }

  return rows;
}

async function fetchUsdInrCsvChunk(fromDate, toDate, onLog) {
  const cookie = await getNseCookie();
  const path = '/api/historicalOR/rbi-reference-rate-stats'
    + `?from=${encodeURIComponent(toNseDate(fromDate))}`
    + `&to=${encodeURIComponent(toNseDate(toDate))}`
    + '&csv=true';

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.nseindia.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'text/csv,application/json,text/plain,*/*',
        'Referer': 'https://www.nseindia.com/',
        'Cookie': cookie,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for USDINR ${fromDate}→${toDate}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const rows = parseUsdInrCsv(data);
          if (onLog) {
            onLog('info', '[FX][NSE] CSV chunk fetched', { fromDate, toDate, rowCount: rows.length });
          }
          resolve(rows);
        } catch (error) {
          reject(new Error(`Failed to parse NSE FX CSV for ${fromDate}→${toDate}: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('NSE FX request timeout'));
    });
    req.end();
  });
}

async function fetchUsdInrNseHistoricalRaw(fromDate, toDate, onLog) {
  const chunks = buildNseFxYearChunks(fromDate, toDate);
  const allRows = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const rows = await fetchUsdInrCsvChunk(chunk.from, chunk.to, onLog);
    allRows.push(...rows);
    if (index < chunks.length - 1) await delay(500);
  }

  const byDate = new Map();
  for (const row of allRows) byDate.set(row.date, row);
  return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
}

async function getUsdInrNseHistoricalPrices(fromDate, toDate, onLog) {
  const rows = await hydrateHistoricalPriceSeries({
    instrumentType: 'FX',
    symbol: 'USDINR=X',
    fromDate,
    toDate,
    sourceLabel: 'NSE_RBI_REFERENCE',
    fetchRange: async (missingFrom, missingTo) => fetchUsdInrNseHistoricalRaw(missingFrom, missingTo, onLog),
    mapFetchedRows: (fetchedRows) => (Array.isArray(fetchedRows) ? fetchedRows : []),
  });

  const out = new Map();
  for (const row of rows) {
    if (row?.date && row.close != null) out.set(row.date, Number(row.close));
  }
  return out;
}

module.exports = {
  buildNseFxYearChunks,
  fetchUsdInrNseHistoricalRaw,
  getUsdInrNseHistoricalPrices,
};