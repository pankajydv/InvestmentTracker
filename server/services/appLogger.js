const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = process.env.APP_LOG_DIR || path.join(DATA_DIR, 'logs');
const RETENTION_DAYS = Math.max(1, Number(process.env.APP_LOG_RETENTION_DAYS || (process.env.NODE_ENV === 'production' ? 10 : 30)));
const IST_OFFSET_MINUTES = 330;
const LOG_FILE_PREFIX = 'invest-tracker';
const LOG_TO_CONSOLE = String(
  process.env.APP_LOG_TO_CONSOLE || (process.env.NODE_ENV === 'production' ? 'false' : 'true')
).toLowerCase() === 'true';

function toIstDate(date = new Date()) {
  return new Date(date.getTime() + (IST_OFFSET_MINUTES * 60 * 1000));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function currentDateStamp() {
  const d = toIstDate();
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  return `${y}-${m}-${day}`;
}

function currentTimestampIst() {
  const d = toIstDate();
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const ms = pad3(d.getUTCMilliseconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}.${ms}+05:30`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function pruneOldLogs() {
  try {
    const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(LOG_DIR, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const name = file.name;
      if (!name.startsWith(`${LOG_FILE_PREFIX}-`) || !name.endsWith('.log')) continue;
      const fullPath = path.join(LOG_DIR, name);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(fullPath, { force: true });
      }
    }
  } catch (_) {
    // best-effort retention
  }
}

function writeLog(_prefix, level, message, meta = null) {
  try {
    ensureLogDir();
    const filePath = path.join(LOG_DIR, `${LOG_FILE_PREFIX}-${currentDateStamp()}.log`);
    const ts = currentTimestampIst();
    const metaPart = meta == null ? '' : ` | ${safeStringify(meta)}`;
    const line = `[${ts}] [${level}] ${message}${metaPart}\n`;
    fs.appendFileSync(filePath, line, 'utf8');

    if (LOG_TO_CONSOLE) {
      const text = line.trimEnd();
      if (level === 'ERROR') {
        console.error(text);
      } else {
        console.log(text);
      }
    }

    pruneOldLogs();
  } catch (_) {
    // best-effort logging only
  }
}

function logAppInfo(message, meta = null) {
  writeLog('app', 'INFO', message, meta);
}

function logAppError(message, meta = null) {
  writeLog('app', 'ERROR', message, meta);
}

function logBackfillInfo(message, meta = null) {
  writeLog('backfill', 'INFO', message, meta);
}

function logBackfillError(message, meta = null) {
  writeLog('backfill', 'ERROR', message, meta);
}

function getUnifiedLogPathForDate(dateStamp = currentDateStamp()) {
  return path.join(LOG_DIR, `${LOG_FILE_PREFIX}-${dateStamp}.log`);
}

function getAppLogPathForDate(dateStamp = currentDateStamp()) {
  return getUnifiedLogPathForDate(dateStamp);
}

function getBackfillLogPathForDate(dateStamp = currentDateStamp()) {
  return getUnifiedLogPathForDate(dateStamp);
}

function getLogDir() {
  return LOG_DIR;
}

module.exports = {
  logAppInfo,
  logAppError,
  logBackfillInfo,
  logBackfillError,
  getUnifiedLogPathForDate,
  getAppLogPathForDate,
  getBackfillLogPathForDate,
  getLogDir,
};
