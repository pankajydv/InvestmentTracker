/**
 * Dashboard Snapshot Service (read-through cache)
 *
 * The dashboard `/summary` endpoint is expensive: it loads all transactions,
 * runs per-investment XIRR, and scans investment_metrics_daily. Because the underlying data
 * only changes on scheduler price updates or explicit mutations, we cache the
 * fully-built summary payload keyed by a monotonic `data_version`.
 *
 * Correctness contract (fail-open, never stale):
 *  - Every cached payload is stamped with the `data_version` it was built at.
 *  - A read only returns a cached payload when its version === current version.
 *    Any mismatch, miss, or error falls through to a live recompute.
 *  - `bumpDataVersion` is called on every price update and on every successful
 *    API mutation (catch-all middleware), so a stale payload is unservable.
 *  - Storage is bounded: writing prunes all rows from older versions, so the
 *    table only ever holds the current version's scopes (a few dozen small rows).
 */

const { logAppWarn } = require('./appLogger');

const DATA_VERSION_KEY = 'dashboard_data_version';

function isSnapshotEnabled() {
  const raw = process.env.ENABLE_DASHBOARD_SNAPSHOT;
  if (raw == null || String(raw).trim() === '') return true; // default ON
  return String(raw).toLowerCase() === 'true';
}

function ensureDashboardSnapshotTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_snapshot (
      cache_key TEXT PRIMARY KEY,
      data_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_snapshot_version ON dashboard_snapshot(data_version);
  `);
}

/**
 * Current data version. Returns a string; defaults to '0' when unset.
 */
function getDataVersion(db) {
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(DATA_VERSION_KEY);
    const value = row?.value != null ? String(row.value) : '';
    return /^\d+$/.test(value) ? value : '0';
  } catch (_e) {
    return '0';
  }
}

/**
 * Increment the monotonic data version. Called by the updater after a price
 * update completes and by the mutation middleware after any successful write.
 * Returns the new version string.
 */
function bumpDataVersion(db) {
  try {
    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(config.value AS INTEGER) + 1,
        updated_at = datetime('now')
    `).run(DATA_VERSION_KEY);
    return getDataVersion(db);
  } catch (err) {
    logAppWarn('Failed to bump dashboard data version', { error: err.message });
    return null;
  }
}

/**
 * Build a stable cache key from the request parameters that affect output.
 * Returns null for inputs that should NOT be cached (custom date ranges), to
 * keep the table bounded.
 */
function buildSnapshotKey(params = {}) {
  const {
    portfolioId,
    hideSold,
    xirrMode,
    interval,
    customFromDate,
    customToDate,
  } = params;

  // Do not cache ad-hoc custom date ranges (unbounded key space).
  if (customFromDate || customToDate) return null;

  return JSON.stringify({
    kind: 'dashboard-summary-v2',
    scope: portfolioId != null ? String(portfolioId) : 'all',
    hideSold: !!hideSold,
    xirrMode: xirrMode === 'portfolio_only' ? 'portfolio_only' : 'full',
    interval: interval || '1D',
  });
}

/**
 * Return the cached payload object for the key at the current version, or null.
 */
function getCachedSnapshot(db, cacheKey, version) {
  if (!cacheKey) return null;
  try {
    const row = db.prepare(
      'SELECT payload_json FROM dashboard_snapshot WHERE cache_key = ? AND data_version = ?'
    ).get(cacheKey, version);
    if (!row?.payload_json) return null;
    return JSON.parse(row.payload_json);
  } catch (err) {
    logAppWarn('Failed to read dashboard snapshot', { error: err.message });
    return null;
  }
}

/**
 * Store the payload for the key at the given version, pruning any rows from
 * older versions so the table only holds the current version's scopes.
 */
function putSnapshot(db, cacheKey, version, payload) {
  if (!cacheKey || !version) return;
  try {
    const json = JSON.stringify(payload);
    db.prepare(`
      INSERT INTO dashboard_snapshot (cache_key, data_version, payload_json, computed_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET
        data_version = excluded.data_version,
        payload_json = excluded.payload_json,
        computed_at = excluded.computed_at
    `).run(cacheKey, version, json);
    // Bounded storage: drop any stale-version rows.
    db.prepare('DELETE FROM dashboard_snapshot WHERE data_version <> ?').run(version);
  } catch (err) {
    logAppWarn('Failed to write dashboard snapshot', { error: err.message });
  }
}

module.exports = {
  DATA_VERSION_KEY,
  isSnapshotEnabled,
  ensureDashboardSnapshotTable,
  getDataVersion,
  bumpDataVersion,
  buildSnapshotKey,
  getCachedSnapshot,
  putSnapshot,
};
