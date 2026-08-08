const fs = require('fs');
const path = require('path');
const util = require('util');
const zlib = require('zlib');
const { applyEnvDefaults } = require('../config/envDefaults');

applyEnvDefaults();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = process.env.APP_LOG_DIR || path.join(DATA_DIR, 'logs');
const APP_MODE = String(process.env.APP_MODE || 'production').toLowerCase();
const RETENTION_DAYS = Math.max(1, Number(process.env.APP_LOG_RETENTION_DAYS || 30));
const IST_OFFSET_MINUTES = 330;
const LOG_FILE_PREFIX = 'invest-tracker';
const LOG_TO_CONSOLE = true;
const CAPTURE_CONSOLE_TO_FILE = String(
  process.env.APP_CAPTURE_CONSOLE_TO_FILE || 'true'
).toLowerCase() === 'true';

const BASE_CONSOLE = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};

let consoleCaptureInstalled = false;
let lastMaintenanceDate = null;

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
      if (!name.startsWith(`${LOG_FILE_PREFIX}-`)) continue;
      if (!name.endsWith('.log') && !name.endsWith('.log.gz')) continue;
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

// Gzip a rotated log file (preserving its mtime so retention counts from the
// log's own date), then remove the uncompressed original.
function compressLogFile(fullPath) {
  try {
    const gzPath = `${fullPath}.gz`;
    if (fs.existsSync(gzPath)) return;
    let mtime = null;
    try { mtime = fs.statSync(fullPath).mtime; } catch (_) {}
    const src = fs.createReadStream(fullPath);
    const gzip = zlib.createGzip();
    const dest = fs.createWriteStream(gzPath);
    const onError = () => {
      try { fs.rmSync(gzPath, { force: true }); } catch (_) {}
    };
    src.on('error', onError);
    gzip.on('error', onError);
    dest.on('error', onError);
    dest.on('finish', () => {
      try { if (mtime) fs.utimesSync(gzPath, mtime, mtime); } catch (_) {}
      fs.rm(fullPath, { force: true }, () => {});
    });
    src.pipe(gzip).pipe(dest);
  } catch (_) {
    console.error('[ERROR] [Logger] Failed to compress rotated log file');
  }
}

// Compress every prior-day log; today's stays uncompressed.
function compressOldLogs() {
  try {
    const today = currentDateStamp();
    const files = fs.readdirSync(LOG_DIR, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const m = file.name.match(/^invest-tracker-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m || m[1] === today) continue;
      compressLogFile(path.join(LOG_DIR, file.name));
    }
  } catch (_) {
    console.error('[ERROR] [Logger] Failed while compressing old log files');
  }
}

// Daily maintenance: keep today's log plain, gzip older ones, delete > retention.
function runLogMaintenance() {
  ensureLogDir();
  compressOldLogs();
  pruneOldLogs();
}

function writeLog(_prefix, level, message, meta = null, options = null) {
  try {
    const opts = options || {};
    const emitToConsole = opts.emitToConsole !== false;
    const skipPrune = opts.skipPrune === true;

    ensureLogDir();
    const filePath = path.join(LOG_DIR, `${LOG_FILE_PREFIX}-${currentDateStamp()}.log`);
    const ts = currentTimestampIst();
    const metaPart = meta == null ? '' : ` | ${safeStringify(meta)}`;
    const line = `[${ts}] [${level}] ${message}${metaPart}\n`;
    fs.appendFileSync(filePath, line, 'utf8');

    if (emitToConsole && LOG_TO_CONSOLE) {
      const text = line.trimEnd();
      if (level === 'ERROR') {
        BASE_CONSOLE.error(text);
      } else if (level === 'WARN') {
        BASE_CONSOLE.warn(text);
      } else if (level === 'DEBUG') {
        BASE_CONSOLE.debug(text);
      } else {
        BASE_CONSOLE.log(text);
      }
    }

    if (!skipPrune) {
      const stamp = currentDateStamp();
      if (stamp !== lastMaintenanceDate) {
        lastMaintenanceDate = stamp;
        runLogMaintenance();
      }
    }
  } catch (_) {
    BASE_CONSOLE.error('[ERROR] [Logger] Failed to write application log entry');
  }
}

function formatConsoleArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    return arg.stack || arg.message || String(arg);
  }
  return util.inspect(arg, { depth: 5, colors: false, breakLength: 120, compact: true });
}

function installConsoleCapture() {
  if (consoleCaptureInstalled) return false;
  if (!CAPTURE_CONSOLE_TO_FILE) return false;

  const map = [
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG'],
  ];

  for (const [method, level] of map) {
    const original = BASE_CONSOLE[method] || BASE_CONSOLE.log;
    console[method] = (...args) => {
      try {
        const message = args.map(formatConsoleArg).join(' ');
        writeLog('console', level, message, null, { emitToConsole: false, skipPrune: true });
      } catch (_) {
        // Always preserve original console behavior even if log persistence fails.
      }
      original(...args);
    };
  }

  consoleCaptureInstalled = true;
  return true;
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

// Run maintenance once at startup: gzip prior days' logs and prune > retention.
try {
  runLogMaintenance();
  lastMaintenanceDate = currentDateStamp();
} catch (_) {
  // best-effort
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
  installConsoleCapture,
};
