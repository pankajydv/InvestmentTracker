function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).split(/[ T]/)[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function formatIstDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function todayIso() {
  return formatIstDate(new Date());
}

function normalizeProviderDate(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const ddmmyyyy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatIstDate(parsed);
  }

  return null;
}

function istDateFromUnixSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return formatIstDate(new Date(n * 1000));
}

function utcDateFromUnixSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

/**
 * Convert a Unix epoch (seconds) to a calendar date (YYYY-MM-DD) in the given
 * exchange timezone (e.g. 'America/New_York', 'Asia/Kolkata').
 *
 * This is the canonical date attribution for market data: a session that closes
 * at 16:00 ET on 02-July stays 02-July even though the equivalent UTC/IST instant
 * may already be 03-July. Falls back to UTC date when the timezone is missing/invalid.
 *
 * @param {number} seconds - Unix epoch seconds
 * @param {string} timeZone - IANA timezone name from provider (exchangeTimezoneName)
 * @returns {string|null} YYYY-MM-DD in the exchange timezone
 */
function exchangeDateFromUnixSeconds(seconds, timeZone) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  const tz = String(timeZone || '').trim();
  if (!tz) return utcDateFromUnixSeconds(n);
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date(n * 1000));
  } catch (_) {
    return utcDateFromUnixSeconds(n);
  }
}

function addDaysIso(isoDate, days) {
  const normalized = toIsoDate(isoDate);
  if (!normalized) return null;
  const [y, m, d] = normalized.split('-').map((p) => Number(p));
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString().slice(0, 10);
}

function eachDateIso(fromDate, toDate) {
  const start = toIsoDate(fromDate);
  const end = toIsoDate(toDate);
  if (!start || !end || start > end) return [];

  const out = [];
  let cursor = start;
  while (cursor <= end) {
    out.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return out;
}

module.exports = {
  toIsoDate,
  formatIstDate,
  normalizeProviderDate,
  istDateFromUnixSeconds,
  utcDateFromUnixSeconds,
  exchangeDateFromUnixSeconds,
  addDaysIso,
  eachDateIso,
  todayIso,
};