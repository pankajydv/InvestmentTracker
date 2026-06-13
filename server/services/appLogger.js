const fs = require('fs');
const path = require('path');
const { applyEnvDefaults } = require('../config/envDefaults');

applyEnvDefaults();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = process.env.APP_LOG_DIR || path.join(DATA_DIR, 'logs');
const APP_MODE = String(process.env.APP_MODE || 'production').toLowerCase();
const IS_PRODUCTION_MODE = APP_MODE !== 'dev' && APP_MODE !== 'development' && APP_MODE !== 'test';
const RETENTION_DAYS = Math.max(1, Number(process.env.APP_LOG_RETENTION_DAYS || (IS_PRODUCTION_MODE ? 10 : 30)));
const IST_OFFSET_MINUTES = 330;
const LOG_FILE_PREFIX = 'invest-tracker';
const LOG_TO_CONSOLE = String(
  process.env.APP_LOG_TO_CONSOLE || (IS_PRODUCTION_MODE ? 'false' : 'true')
).toLowerCase() === 'true';

function toIstDate(date = new Date()) {
  return new Date(date.getTime() + (IST_OFFSET_MINUTES * 60 * 1000));
}

function pad2(n) {
  return String(n).padStart(2, '0');
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
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${hh}:${mm}:${ss}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    console.error('[ERROR] [Logger] Failed to JSON stringify log meta payload');
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
    console.error('[ERROR] [Logger] Failed while pruning old log files');
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
      } else if (level === 'WARN') {
        console.warn(text);
      } else {
        console.log(text);
      }
    }

    pruneOldLogs();
  } catch (_) {
    console.error('[ERROR] [Logger] Failed to write application log entry');
  }
}

function logAppInfo(message, meta = null) {
  writeLog('app', 'INFO', message, meta);
}

function logAppWarn(message, meta = null) {
  writeLog('app', 'WARN', message, meta);
}

function logAppError(message, meta = null) {
  writeLog('app', 'ERROR', message, meta);
}

function logBackfillInfo(message, meta = null) {
  writeLog('backfill', 'INFO', message, meta);
}

function logBackfillWarn(message, meta = null) {
  writeLog('backfill', 'WARN', message, meta);
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
  logAppWarn,
  logAppError,
  logBackfillInfo,
  logBackfillWarn,
  logBackfillError,
  getUnifiedLogPathForDate,
  getAppLogPathForDate,
  getBackfillLogPathForDate,
  getLogDir,
};
