// Utility to fetch and parse NSE bhavcopy for SGB historical prices
// Usage: getSGBHistoricalPrices(symbol, fromDate, toDate)
// Returns: Map<YYYY-MM-DD, closePrice>
//
// NSE changed bhavcopy format/host around 2024:
//   Pre-2024:  archives.nseindia.com  SYMBOL/SERIES/CLOSE columns
//   2024+:  nsearchives.nseindia.com  TckrSymb/SctySrs/ClsPric columns

const https = require('https');
const AdmZip = require('adm-zip');
const { hydrateHistoricalPriceSeries } = require('./marketPriceCache');

function pad(n) { return n < 10 ? '0' + n : '' + n; }

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Returns { url, format: 'old'|'new' }
function getBhavcopyUrlInfo(date) {
  // date: YYYY-MM-DD
  const [y, m, d] = date.split('-');
  const year = Number(y);
  if (year >= 2024) {
    // New format: nsearchives, YYYYMMDD in filename
    const yyyymmdd = `${y}${pad(Number(m))}${pad(Number(d))}`;
    return {
      url: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${yyyymmdd}_F_0000.csv.zip`,
      format: 'new',
    };
  } else {
    // Old format: archives.nseindia.com
    const dd = pad(Number(d));
    const mon = MONTHS[Number(m) - 1];
    return {
      url: `https://archives.nseindia.com/content/historical/EQUITIES/${y}/${mon}/cm${dd}${mon}${y}bhav.csv.zip`,
      format: 'old',
    };
  }
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/octet-stream, */*',
      'Referer': 'https://www.nseindia.com/',
    };
    const req = https.get(url, { headers }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => resolve(Buffer.concat(bufs)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractCSVFromZip(zipBuf) {
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries().filter(e => e.entryName.endsWith('.csv'));
  if (!entries.length) throw new Error('No CSV in zip');
  return zip.readAsText(entries[0]);
}

function parseBhavcopyCSV(csv, symbol, format) {
  const lines = csv.split(/\r?\n/);
  if (!lines.length) return null;
  const header = lines[0].split(',').map(h => h.trim());

  let idxSym, idxSeries, idxClose;
  if (format === 'new') {
    idxSym = header.indexOf('TckrSymb');
    idxSeries = header.indexOf('SctySrs');
    idxClose = header.indexOf('ClsPric');
  } else {
    // old format
    idxSym = header.indexOf('SYMBOL');
    idxSeries = header.indexOf('SERIES');
    idxClose = header.indexOf('CLOSE');
  }
  if (idxSym < 0 || idxClose < 0) return null;

  const symUpper = symbol.toUpperCase();
  for (let i = 1; i < lines.length; ++i) {
    const cols = lines[i].split(',');
    if (cols.length <= idxClose) continue;
    if (cols[idxSym]?.trim().toUpperCase() === symUpper) {
      // Accept GB series (SGBs)
      const series = idxSeries >= 0 ? cols[idxSeries]?.trim() : 'GB';
      if (series === 'GB') {
        const price = parseFloat(cols[idxClose]);
        if (!isNaN(price) && price > 0) return price;
      }
    }
  }
  return null;
}

// Rate-limit: small delay between requests
const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchSGBHistoricalRaw(symbol, fromDate, toDate) {
  const out = [];

  let d = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  let consecutiveErrors = 0;

  while (d <= end) {
    const dow = d.getUTCDay();
    // Skip weekends
    if (dow !== 0 && dow !== 6) {
      const y = d.getUTCFullYear();
      const m = pad(d.getUTCMonth() + 1);
      const day = pad(d.getUTCDate());
      const dateStr = `${y}-${m}-${day}`;
      try {
        const { url, format } = getBhavcopyUrlInfo(dateStr);
        const zipBuf = await fetchBuffer(url);
        const csv = extractCSVFromZip(zipBuf);
        const price = parseBhavcopyCSV(csv, symbol, format);
        if (price != null) {
          out.push({ date: dateStr, close: Number(price), source: 'NSE_BHAVCOPY' });
          consecutiveErrors = 0;
        }
        await delay(150);
      } catch (e) {
        consecutiveErrors++;
        // Back off if we're getting lots of consecutive errors (likely rate-limited/blocked)
        if (consecutiveErrors >= 10) {
          await delay(3000);
          consecutiveErrors = 0;
        }
      }
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return out;
}

async function getSGBHistoricalPrices(symbol, fromDate, toDate) {
  const rows = await hydrateHistoricalPriceSeries({
    instrumentType: 'SGB',
    symbol,
    fromDate,
    toDate,
    sourceLabel: 'NSE_BHAVCOPY',
    fetchRange: async (missingFrom, missingTo) => fetchSGBHistoricalRaw(symbol, missingFrom, missingTo),
    mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
  });

  const out = new Map();
  for (const row of rows) {
    if (row?.date && row.close != null) out.set(row.date, Number(row.close));
  }
  return out;
}

module.exports = { getSGBHistoricalPrices, fetchSGBHistoricalRaw, parseBhavcopyCSV, extractCSVFromZip };

