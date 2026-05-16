const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = process.env.APP_LOG_DIR || path.join(DATA_DIR, 'logs');
const RETENTION_DAYS = Math.max(1, Number(process.env.APP_LOG_RETENTION_DAYS || (process.env.NODE_ENV === 'production' ? 10 : 30)));

function currentDateStamp() {
  return new Date().toISOString().slice(0, 10);
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

function pruneOldLogs(prefix) {
  try {
    const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(LOG_DIR, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const name = file.name;
      if (!name.startsWith(`${prefix}-`) || !name.endsWith('.log')) continue;
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

function writeLog(prefix, level, message, meta = null) {
  try {
    ensureLogDir();
    const filePath = path.join(LOG_DIR, `${prefix}-${currentDateStamp()}.log`);
    const ts = new Date().toISOString();
    const metaPart = meta == null ? '' : ` | ${safeStringify(meta)}`;
    const line = `[${ts}] [${level}] ${message}${metaPart}\n`;
    fs.appendFileSync(filePath, line, 'utf8');

    pruneOldLogs(prefix);
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

function getAppLogPathForDate(dateStamp = currentDateStamp()) {
  return path.join(LOG_DIR, `app-${dateStamp}.log`);
}

function getBackfillLogPathForDate(dateStamp = currentDateStamp()) {
  return path.join(LOG_DIR, `backfill-${dateStamp}.log`);
}

function getLogDir() {
  return LOG_DIR;
}

module.exports = {
  logAppInfo,
  logAppError,
  logBackfillInfo,
  logBackfillError,
  getAppLogPathForDate,
  getBackfillLogPathForDate,
  getLogDir,
};
