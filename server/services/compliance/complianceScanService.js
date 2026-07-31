// Compliance scan for missing daily_values, portfolio_daily, asset_type_daily
const { applyEnvDefaults } = require('../../config/envDefaults');
applyEnvDefaults();

const { getDb } = require('../../db/schema');
const { getMarketHolidays, getWeekends } = require('../holidays/marketHolidayService');
const { markScopeDirty } = require('../dirtyBackfillService');
const { LOCF_STREAK_WARN_SESSIONS, FOREIGN_STOCK_LOCF_STREAK_WARN_SESSIONS } = require('../freshnessPolicy');

const COMPLIANCE_SCAN_FLOOR_KEY = 'compliance_scan_floor';
const COMPLIANCE_LAST_MODE_KEY = 'compliance_last_mode';
const COMPLIANCE_LAST_RUN_DATE_KEY = 'compliance_last_run_date';
const COMPLIANCE_LAST_GAPS_KEY = 'compliance_last_gaps_detected';
const COMPLIANCE_LAST_REPAIRS_KEY = 'compliance_last_repairs_enqueued';
const INCREMENTAL_LOOKBACK_DAYS = Math.max(1, Number(process.env.INCREMENTAL_COMPLIANCE_LOOKBACK_DAYS || 14));
const BALANCE_BASED_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);
const MARKET_DATA_CUTOFF_MINUTES_IST = Object.freeze({
  // US equities settle after midnight IST; avoid same-day compliance gaps until end of IST day.
  FOREIGN_STOCK: 23 * 60 + 59,
});

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function addDaysIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function minIsoDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a < b ? a : b;
}

function getIstClock(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const values = {};
  for (const part of parts) {
    if (!part?.type || part.type === 'literal') continue;
    values[part.type] = part.value;
  }

  const date = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour || 0);
  const minute = Number(values.minute || 0);
  return {
    date,
    minutes: (hour * 60) + minute,
  };
}

function shouldDeferSameDayMarketLinkedGap(assetType, runDate) {
  const normalized = String(assetType || '').toUpperCase();
  if (normalized !== 'FOREIGN_STOCK') return false;
  if (!runDate) return false;

  const istNow = getIstClock();
  if (runDate !== istNow.date) return false;

  const cutoffMinutes = MARKET_DATA_CUTOFF_MINUTES_IST[normalized];
  if (!Number.isFinite(cutoffMinutes)) return false;
  return istNow.minutes < cutoffMinutes;
}

function getConfigValue(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1').get(key);
  return row?.value != null ? String(row.value) : null;
}

function upsertConfigValue(db, key, value) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, String(value == null ? '' : value));
}

function getEarliestDirtyFromDate(db, runDate) {
  const row = db.prepare(`
    SELECT MIN(dirty_from_date) AS min_dirty_from
    FROM dirty_backfill_scope
    WHERE status IN ('pending', 'running', 'failed')
      AND dirty_from_date <= ?
  `).get(runDate);
  return parseIsoDate(row?.min_dirty_from);
}

function getComplianceScanFloor(db) {
  return parseIsoDate(getConfigValue(db, COMPLIANCE_SCAN_FLOOR_KEY));
}

function resolveScanWindow(db, options = {}) {
  const runDate = parseIsoDate(options.runDate) || todayIso();
  const mode = String(options.mode || 'full').toLowerCase();

  if (mode === 'full' || mode === 'deep') {
    return {
      mode: 'full',
      runDate,
      startDate: null,
      endDate: runDate,
      scanFloor: getComplianceScanFloor(db),
      dirtyFrom: getEarliestDirtyFromDate(db, runDate),
      lookbackDays: null,
    };
  }

  const scanFloor = getComplianceScanFloor(db);
  const dirtyFrom = getEarliestDirtyFromDate(db, runDate);
  const lookbackDays = Math.max(1, Number(options.lookbackDays || INCREMENTAL_LOOKBACK_DAYS));
  const lookbackStart = addDaysIso(runDate, -lookbackDays);

  let startDate = lookbackStart;
  if (scanFloor) startDate = minIsoDate(startDate, scanFloor);
  if (dirtyFrom) startDate = minIsoDate(startDate, dirtyFrom);

  if (startDate > runDate) startDate = runDate;

  return {
    mode: 'incremental',
    runDate,
    startDate,
    endDate: runDate,
    scanFloor,
    dirtyFrom,
    lookbackDays,
  };
}

function persistComplianceState(db, window) {
  const nextDirtyFrom = getEarliestDirtyFromDate(db, window.endDate || window.runDate || todayIso());
  upsertConfigValue(db, COMPLIANCE_SCAN_FLOOR_KEY, nextDirtyFrom || '');
  return {
    scanFloor: nextDirtyFrom || null,
  };
}

function refreshComplianceScanFloor(db, runDate = todayIso()) {
  const effectiveRunDate = parseIsoDate(runDate) || todayIso();
  const nextDirtyFrom = getEarliestDirtyFromDate(db, effectiveRunDate);
  upsertConfigValue(db, COMPLIANCE_SCAN_FLOOR_KEY, nextDirtyFrom || '');
  return nextDirtyFrom || null;
}

function persistComplianceRunMeta(db, result) {
  upsertConfigValue(db, COMPLIANCE_LAST_MODE_KEY, result.mode || 'full');
  upsertConfigValue(db, COMPLIANCE_LAST_RUN_DATE_KEY, result.runDate || todayIso());
  upsertConfigValue(db, COMPLIANCE_LAST_GAPS_KEY, Number(result.gapsDetected || 0));
  upsertConfigValue(db, COMPLIANCE_LAST_REPAIRS_KEY, Number(result.repairsEnqueued || 0));
}

function getComplianceScanState(runDate = todayIso(), dbOverride = null) {
  const db = dbOverride || getDb();
  const shouldCloseDb = !dbOverride;
  try {
    const effectiveRunDate = parseIsoDate(runDate) || todayIso();
    const scanFloor = getComplianceScanFloor(db);
    const dirtyFrom = getEarliestDirtyFromDate(db, effectiveRunDate);
    const lastMode = getConfigValue(db, COMPLIANCE_LAST_MODE_KEY) || null;
    const lastRunDate = parseIsoDate(getConfigValue(db, COMPLIANCE_LAST_RUN_DATE_KEY));
    const lastGapsDetected = Number(getConfigValue(db, COMPLIANCE_LAST_GAPS_KEY) || 0);
    const lastRepairsEnqueued = Number(getConfigValue(db, COMPLIANCE_LAST_REPAIRS_KEY) || 0);
    const openGapCount = db.prepare('SELECT COUNT(*) AS c FROM daily_data_gaps WHERE resolved_at IS NULL').get()?.c || 0;

    return {
      runDate: effectiveRunDate,
      scanFloor,
      dirtyFrom,
      openGapCount: Number(openGapCount || 0),
      hasBacklog: !!(dirtyFrom || scanFloor || Number(openGapCount || 0) > 0),
      lastScan: {
        mode: lastMode,
        runDate: lastRunDate,
        gapsDetected: Number.isFinite(lastGapsDetected) ? lastGapsDetected : 0,
        repairsEnqueued: Number.isFinite(lastRepairsEnqueued) ? lastRepairsEnqueued : 0,
      },
    };
  } finally {
    if (shouldCloseDb) db.close();
  }
}

/**
 * Returns a Set of YYYY-MM-DD strings for all holidays and weekends for a year
 */
function getHolidayAndWeekendSet(year, db) {
  const holidays = getMarketHolidays(year, db).map(h => h.date);
  const weekends = getWeekends(year).map(w => w.date);
  return new Set([...holidays, ...weekends]);
}

/**
 * Determine if an investment is market-linked based on asset_type
 */
function isMarketLinkedAsset(assetType) {
  const normalized = String(assetType || '').toUpperCase();
  return normalized === 'INDIAN_STOCK'
    || normalized === 'FOREIGN_STOCK'
    || normalized === 'MUTUAL_FUND'
    || normalized === 'SGB'
    || normalized === 'NPS'
    || normalized === 'BOND';
}

/**
 * Generic gap detection for any table
 * @param {string} tableName - Target table (daily_values, portfolio_daily, asset_type_daily)
 * @param {string} keyColumn - Column name for entity ID (investment_id, portfolio_id, asset_type)
 * @param {string} keyType - Type of key for filtering (investment, portfolio, asset_type)
 * @returns {array} Array of gap objects to record
 */
function detectGapsForTable(db, tableName, keyColumn, keyType, options = {}) {
  const now = new Date();
  const year = now.getFullYear();
  const holidaySet = getHolidayAndWeekendSet(year, db);
  const startBoundary = parseIsoDate(options.startDate);
  const endBoundary = parseIsoDate(options.endDate) || todayIso();

  const gaps = [];

  if (tableName === 'daily_values') {
    // For daily_values: get investments and check their date ranges
    const investments = db.prepare(`
      SELECT DISTINCT i.id, i.asset_type, i.is_active, i.exclude_from_tracking,
             MIN(date(t.transaction_date)) as start_date, MAX(date(t.transaction_date)) as end_date
      FROM investments i
      LEFT JOIN transactions t ON i.id = t.investment_id
      WHERE t.transaction_date IS NOT NULL
      GROUP BY i.id
    `).all();

    for (const inv of investments) {
      const { id, asset_type, start_date, end_date } = inv;
      if (!start_date || !end_date) continue;

      const effectiveStartDate = startBoundary && startBoundary > start_date ? startBoundary : start_date;
      const trackBalanceThroughScanDate = BALANCE_BASED_ASSET_TYPES.has(String(asset_type || '').toUpperCase())
        && inv.is_active !== 0
        && inv.exclude_from_tracking !== 1;
      let effectiveEndDate = trackBalanceThroughScanDate
        ? endBoundary
        : (endBoundary && endBoundary < end_date ? endBoundary : end_date);
      if (shouldDeferSameDayMarketLinkedGap(asset_type, endBoundary) && effectiveEndDate === endBoundary) {
        effectiveEndDate = addDaysIso(effectiveEndDate, -1);
      }
      if (!effectiveStartDate || !effectiveEndDate || effectiveStartDate > effectiveEndDate) continue;

      const isMarketLinked = isMarketLinkedAsset(asset_type);
      let gapStart = null;

      let d = new Date(`${effectiveStartDate}T00:00:00.000Z`);
      const end = new Date(`${effectiveEndDate}T00:00:00.000Z`);

      while (d <= end) {
        const dateStr = d.toISOString().slice(0, 10);

        // Skip holidays/weekends for market-linked assets
        if (isMarketLinked && holidaySet.has(dateStr)) {
          if (gapStart) {
            gaps.push({
              table_name: tableName,
              entity_id: id,
              gap_start_date: gapStart,
              gap_end_date: new Date(d.getTime() - 86400000).toISOString().slice(0, 10),
            });
            gapStart = null;
          }
          d.setDate(d.getDate() + 1);
          continue;
        }

        const exists = db.prepare(`SELECT 1 FROM ${tableName} WHERE ${keyColumn} = ? AND date = ?`).get(id, dateStr);
        
        if (!exists) {
          if (!gapStart) {
            gapStart = dateStr;
          }
        } else {
          if (gapStart) {
            gaps.push({
              table_name: tableName,
              entity_id: id,
              gap_start_date: gapStart,
              gap_end_date: new Date(d.getTime() - 86400000).toISOString().slice(0, 10),
            });
            gapStart = null;
          }
        }

        d.setDate(d.getDate() + 1);
      }

      // Close any open gap
      if (gapStart) {
        gaps.push({
          table_name: tableName,
          entity_id: id,
          gap_start_date: gapStart,
          gap_end_date: effectiveEndDate,
        });
      }
    }
  } else if (tableName === 'portfolio_daily') {
    // For portfolio_daily: get portfolios and check their date ranges
    const portfolios = db.prepare(`
      SELECT DISTINCT p.id,
             MIN(dv.date) as start_date, MAX(dv.date) as end_date
      FROM portfolios p
      LEFT JOIN daily_values dv ON p.id = (
        SELECT portfolio_id FROM investments WHERE id = dv.investment_id
      )
      WHERE dv.date IS NOT NULL
      GROUP BY p.id
    `).all();

    for (const pf of portfolios) {
      const { id, start_date, end_date } = pf;
      if (!start_date || !end_date) continue;

      const effectiveStartDate = startBoundary && startBoundary > start_date ? startBoundary : start_date;
      const effectiveEndDate = endBoundary && endBoundary < end_date ? endBoundary : end_date;
      if (!effectiveStartDate || !effectiveEndDate || effectiveStartDate > effectiveEndDate) continue;

      let gapStart = null;

      let d = new Date(`${effectiveStartDate}T00:00:00.000Z`);
      const end = new Date(`${effectiveEndDate}T00:00:00.000Z`);

      while (d <= end) {
        const dateStr = d.toISOString().slice(0, 10);

        const exists = db.prepare(`SELECT 1 FROM ${tableName} WHERE ${keyColumn} = ? AND date = ?`).get(id, dateStr);
        
        if (!exists) {
          if (!gapStart) {
            gapStart = dateStr;
          }
        } else {
          if (gapStart) {
            gaps.push({
              table_name: tableName,
              entity_id: id,
              gap_start_date: gapStart,
              gap_end_date: new Date(d.getTime() - 86400000).toISOString().slice(0, 10),
            });
            gapStart = null;
          }
        }

        d.setDate(d.getDate() + 1);
      }

      // Close any open gap
      if (gapStart) {
        gaps.push({
          table_name: tableName,
          entity_id: id,
          gap_start_date: gapStart,
          gap_end_date: effectiveEndDate,
        });
      }
    }
  } else if (tableName === 'asset_type_daily') {
    // For asset_type_daily: get asset types and check their date ranges
    const assetTypes = db.prepare(`
      SELECT DISTINCT i.asset_type,
             MIN(dv.date) as start_date, MAX(dv.date) as end_date
      FROM investments i
      LEFT JOIN daily_values dv ON i.id = dv.investment_id
      WHERE dv.date IS NOT NULL
      GROUP BY i.asset_type
    `).all();

    for (const at of assetTypes) {
      const { asset_type, start_date, end_date } = at;
      if (!start_date || !end_date) continue;

      const effectiveStartDate = startBoundary && startBoundary > start_date ? startBoundary : start_date;
      const effectiveEndDate = endBoundary && endBoundary < end_date ? endBoundary : end_date;
      if (!effectiveStartDate || !effectiveEndDate || effectiveStartDate > effectiveEndDate) continue;

      let gapStart = null;

      let d = new Date(`${effectiveStartDate}T00:00:00.000Z`);
      const end = new Date(`${effectiveEndDate}T00:00:00.000Z`);

      while (d <= end) {
        const dateStr = d.toISOString().slice(0, 10);

        const exists = db.prepare(`SELECT 1 FROM ${tableName} WHERE ${keyColumn} = ? AND date = ?`).get(asset_type, dateStr);
        
        if (!exists) {
          if (!gapStart) {
            gapStart = dateStr;
          }
        } else {
          if (gapStart) {
            gaps.push({
              table_name: tableName,
              entity_id: asset_type,
              gap_start_date: gapStart,
              gap_end_date: new Date(d.getTime() - 86400000).toISOString().slice(0, 10),
            });
            gapStart = null;
          }
        }

        d.setDate(d.getDate() + 1);
      }

      // Close any open gap
      if (gapStart) {
        gaps.push({
          table_name: tableName,
          entity_id: asset_type,
          gap_start_date: gapStart,
          gap_end_date: effectiveEndDate,
        });
      }
    }
  }

  return gaps;
}

/**
 * Find and record missing gaps across all three daily tables
 * Scans daily_values, portfolio_daily, and asset_type_daily in one pass
 */
function findAndRecordAllGaps(db, options = {}) {
  const allGaps = [];
  const window = {
    startDate: parseIsoDate(options.startDate),
    endDate: parseIsoDate(options.endDate) || todayIso(),
  };

  try {
    // Scan daily_values
    const dailyValuesGaps = detectGapsForTable(db, 'daily_values', 'investment_id', 'investment', window);
    allGaps.push(...dailyValuesGaps);

    // Scan portfolio_daily
    const portfolioDailyGaps = detectGapsForTable(db, 'portfolio_daily', 'portfolio_id', 'portfolio', window);
    allGaps.push(...portfolioDailyGaps);

    // Scan asset_type_daily
    const assetTypeDailyGaps = detectGapsForTable(db, 'asset_type_daily', 'asset_type', 'asset_type', window);
    allGaps.push(...assetTypeDailyGaps);
  } catch (e) {
    console.error('[ComplianceScan] Error detecting gaps:', e.message);
    return [];
  }

  // Record all gaps in database
  const insertGap = db.prepare(`
    INSERT OR REPLACE INTO daily_data_gaps (table_name, entity_id, gap_start_date, gap_end_date, detected_at, resolved_at)
    VALUES (?, ?, ?, ?, datetime('now'), NULL)
  `);

  for (const gap of allGaps) {
    try {
      insertGap.run(gap.table_name, gap.entity_id, gap.gap_start_date, gap.gap_end_date);
    } catch (e) {
      console.error('[ComplianceScan] Error recording gap:', e.message);
    }
  }

  return allGaps;
}

/**
 * Legacy function for backward compatibility - redirects to findAndRecordAllGaps
 */
function findAndRecordDailyValuesGaps(db, options = {}) {
  return findAndRecordAllGaps(db, options);
}

/**
 * Detect market-linked scopes whose recent daily_values are all LOCF (no LIVE row
 * within the freshness window).  Emits a WARN log per scope and marks it dirty.
 *
 * @param {object} db
 * @param {{ endDate?: string }} [options]
 * @returns {{ issues: Array, repairsEnqueued: number }}
 */
function detectLocfQualityIssues(db, options = {}) {
  const endDate = parseIsoDate(options.endDate) || todayIso();
  // Generous calendar window: 3 sessions can span up to ~7 calendar days around holidays.
  const lookbackDays = Math.max(1, Number(options.lookbackDays || Math.max(INCREMENTAL_LOOKBACK_DAYS, LOCF_STREAK_WARN_SESSIONS * 3)));
  const startDate = addDaysIso(endDate, -lookbackDays);

  const MARKET_LINKED_TYPES = ['INDIAN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB', 'FOREIGN_STOCK'];
  const placeholders = MARKET_LINKED_TYPES.map(() => '?').join(',');

  // Per-asset-type streak thresholds (generous calendar-day proxy for market sessions).
  // FOREIGN_STOCK gets a higher tolerance (5 sessions × 2 = 10 days) because after-hours
  // attribution naturally causes 1 LOCF per day boundary; US holidays also not mapped.
  // Other assets use the standard 3 sessions × 2 = 6 days.
  const fsStreakThreshold    = addDaysIso(endDate, -(FOREIGN_STOCK_LOCF_STREAK_WARN_SESSIONS * 2));
  const otherStreakThreshold = addDaysIso(endDate, -(LOCF_STREAK_WARN_SESSIONS * 2));

  const rows = db.prepare(`
    SELECT
      dv.investment_id,
      dv.portfolio_id,
      i.asset_type,
      i.name AS investment_name,
      MAX(dv.date) AS latest_date,
      -- last_live_date: most recent date with an official LIVE (regular-session) close.
      -- PRE/POST are preliminary and count as non-live for streak detection.
      MAX(CASE WHEN UPPER(COALESCE(dv.price_source, '')) = 'LIVE' THEN dv.date END) AS last_non_locf_date,
      SUM(CASE WHEN UPPER(COALESCE(dv.price_source, '')) <> 'LIVE' THEN 1 ELSE 0 END) AS locf_count_in_window
    FROM daily_values dv
    JOIN investments i ON i.id = dv.investment_id
    WHERE i.asset_type IN (${placeholders})
      AND i.is_active != 0
      AND COALESCE(i.exclude_from_tracking, 0) != 1
      AND dv.portfolio_id IS NOT NULL
      AND date(dv.date) >= ?
      AND date(dv.date) <= ?
    GROUP BY dv.investment_id, dv.portfolio_id
    HAVING last_non_locf_date IS NULL
        OR last_non_locf_date < CASE WHEN i.asset_type = 'FOREIGN_STOCK' THEN ? ELSE ? END
  `).all(...MARKET_LINKED_TYPES, startDate, endDate, fsStreakThreshold, otherStreakThreshold);

  const issues = [];
  let repairsEnqueued = 0;

  for (const row of rows) {
    const dirtyFrom = row.last_non_locf_date
      ? addDaysIso(row.last_non_locf_date, 1)
      : startDate;

    issues.push({
      investment_id: row.investment_id,
      portfolio_id: row.portfolio_id,
      asset_type: row.asset_type,
      investment_name: row.investment_name,
      latest_date: row.latest_date,
      last_non_locf_date: row.last_non_locf_date,
      locf_count_in_window: row.locf_count_in_window,
      dirty_from: dirtyFrom,
    });

    console.warn(
      `[ComplianceScan][LOCF-Quality][WARN] ${row.asset_type} inv=${row.investment_id}` +
      ` (${row.investment_name}) portfolio=${row.portfolio_id}` +
      ` latest=${row.latest_date} lastNonLocf=${row.last_non_locf_date || 'none'}` +
      ` locfCount=${row.locf_count_in_window} dirtyFrom=${dirtyFrom}`
    );

    try {
      const dirty = markScopeDirty(db, {
        investmentId: row.investment_id,
        portfolioId: row.portfolio_id,
        dirtyFromDate: dirtyFrom,
        reason: 'compliance-locf-quality',
        sourceEventId: `compliance-locf:${endDate}`,
      });
      if (dirty) repairsEnqueued += 1;
    } catch (e) {
      console.error(
        `[ComplianceScan][LOCF-Quality] Failed to mark scope dirty for inv=${row.investment_id}` +
        ` portfolio=${row.portfolio_id}:`, e.message
      );
    }
  }

  if (issues.length > 0) {
    console.warn(
      `[ComplianceScan][LOCF-Quality] ${issues.length} scope(s) with LOCF streak` +
      ` >= ${LOCF_STREAK_WARN_SESSIONS} market sessions; ${repairsEnqueued} dirty scope(s) enqueued.`
    );
  }

  return { issues, repairsEnqueued };
}

function emitProgress(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (_) {
    console.error('[ComplianceScan] Error emitting progress callback');
  }
}

function scanAndRepairComplianceGaps(options = {}) {
  const db = options.db || getDb();
  const shouldCloseDb = !options.db;
  try {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  emitProgress(onProgress, { phase: 'resolving-window', percent: 5 });
  const window = resolveScanWindow(db, options);
  emitProgress(onProgress, {
    phase: 'scanning',
    percent: 25,
    window: {
      startDate: window.startDate,
      endDate: window.endDate,
      mode: window.mode,
    },
  });

  const gaps = findAndRecordAllGaps(db, {
    startDate: window.startDate,
    endDate: window.endDate,
  });

  emitProgress(onProgress, {
    phase: 'repairing',
    percent: 65,
    gapsDetected: gaps.length,
  });

  const repairCount = gaps.length > 0 ? repairDetectedGaps(db) : 0;

  // Run LOCF quality scan (detects persistent LOCF streaks beyond threshold).
  const qualityResult = detectLocfQualityIssues(db, { endDate: window.endDate || window.runDate });

  emitProgress(onProgress, {
    phase: 'persisting-state',
    percent: 90,
    repairsEnqueued: repairCount + qualityResult.repairsEnqueued,
  });

  const state = persistComplianceState(db, window);

  const result = {
    mode: window.mode,
    runDate: window.runDate,
    window: {
      startDate: window.startDate,
      endDate: window.endDate,
      lookbackDays: window.lookbackDays,
      scanFloorBefore: window.scanFloor,
      dirtyFrom: window.dirtyFrom,
      scanFloorAfter: state.scanFloor,
    },
    gapsDetected: gaps.length,
    repairsEnqueued: repairCount + qualityResult.repairsEnqueued,
    locfQualityIssues: qualityResult.issues.length,
    gaps,
  };

  persistComplianceRunMeta(db, result);
  emitProgress(onProgress, {
    phase: 'completed',
    percent: 100,
    gapsDetected: result.gapsDetected,
    repairsEnqueued: result.repairsEnqueued,
  });
  return result;
  } finally {
    if (shouldCloseDb) db.close();
  }
}

/**
 * Get all open gaps for dashboard display
 */
function getOpenGaps(dbOverride = null) {
  const db = dbOverride || getDb();
  const shouldCloseDb = !dbOverride;
  try {
    return db.prepare(`
      SELECT table_name, entity_id, gap_start_date, gap_end_date, detected_at
      FROM daily_data_gaps
      WHERE resolved_at IS NULL
      ORDER BY detected_at DESC
    `).all();
  } finally {
    if (shouldCloseDb) db.close();
  }
}

/**
 * Mark a gap as resolved
 */
function markGapResolved(db, tableName, entityId, gapStartDate, gapEndDate) {
  db.prepare(`
    UPDATE daily_data_gaps
    SET resolved_at = datetime('now')
    WHERE table_name = ? AND entity_id = ? AND gap_start_date = ? AND gap_end_date = ?
  `).run(tableName, entityId, gapStartDate, gapEndDate);
}

/**
 * Repair gaps by marking affected entities as dirty for backfill
 * This is called after compliance scan to automatically enqueue gap repair
 */
function repairDetectedGaps(dbOverride = null) {
  const db = dbOverride || getDb();
  const shouldCloseDb = !dbOverride;
  const openGaps = getOpenGaps(db);
  let repairCount = 0;

  try {
    for (const gap of openGaps) {
      try {
        if (gap.table_name === 'daily_values') {
          // Mark investment as dirty for backfill
          const result = markScopeDirty(db, {
            investmentId: gap.entity_id,
            portfolioId: null,
            dirtyFromDate: gap.gap_start_date,
            reason: `Gap repair: ${gap.gap_start_date} to ${gap.gap_end_date}`,
            sourceEventId: `gap_repair_${gap.table_name}_${gap.entity_id}_${gap.gap_start_date}`,
          });

          if (result) {
            markGapResolved(db, gap.table_name, gap.entity_id, gap.gap_start_date, gap.gap_end_date);
            repairCount++;
          }
        } else if (gap.table_name === 'portfolio_daily') {
          // Mark portfolio as dirty for backfill
          const result = markScopeDirty(db, {
            investmentId: null,
            portfolioId: gap.entity_id,
            dirtyFromDate: gap.gap_start_date,
            reason: `Gap repair: ${gap.gap_start_date} to ${gap.gap_end_date}`,
            sourceEventId: `gap_repair_${gap.table_name}_${gap.entity_id}_${gap.gap_start_date}`,
          });

          if (result) {
            markGapResolved(db, gap.table_name, gap.entity_id, gap.gap_start_date, gap.gap_end_date);
            repairCount++;
          }
        } else if (gap.table_name === 'asset_type_daily') {
          // For asset type gaps, mark all investments of that asset type as dirty
          const investments = db.prepare(`
            SELECT id FROM investments WHERE asset_type = ?
          `).all(gap.entity_id);

          for (const inv of investments) {
            const result = markScopeDirty(db, {
              investmentId: inv.id,
              portfolioId: null,
              dirtyFromDate: gap.gap_start_date,
              reason: `Gap repair: ${gap.gap_start_date} to ${gap.gap_end_date} (asset_type: ${gap.entity_id})`,
              sourceEventId: `gap_repair_${gap.table_name}_${gap.entity_id}_${gap.gap_start_date}_inv${inv.id}`,
            });

            if (result) {
              repairCount++;
            }
          }

          if (investments.length > 0) {
            markGapResolved(db, gap.table_name, gap.entity_id, gap.gap_start_date, gap.gap_end_date);
          }
        }
      } catch (e) {
        console.error('[ComplianceScan] Error repairing gap:', gap, e.message);
      }
    }

    return repairCount;
  } finally {
    if (shouldCloseDb) db.close();
  }
}

module.exports = {
  isMarketLinkedAsset,
  detectGapsForTable,
  findAndRecordDailyValuesGaps,
  findAndRecordAllGaps,
  detectLocfQualityIssues,
  scanAndRepairComplianceGaps,
  refreshComplianceScanFloor,
  getComplianceScanState,
  getOpenGaps,
  markGapResolved,
  repairDetectedGaps,
};

