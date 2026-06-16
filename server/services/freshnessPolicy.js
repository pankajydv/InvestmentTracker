'use strict';

// ─── Canonical Freshness Policy ───────────────────────────────────────────────
//
// All market-linked price quality checks, dirty-scope thresholds, and display
// fallback limits MUST reference this module instead of hardcoding values.
// A single change here propagates automatically to every consumer.

const FRESHNESS_POLICY = Object.freeze({
  // Rolling window of market sessions used by the rolling dirty-scope sweep (scheduler Step-1).
  // Scopes with any LOCF or missing row within this window are marked dirty for backfill.
  DIRTY_SCOPE_LOOKBACK_SESSIONS: 5,

  // Consecutive market-session LOCF rows before a warning is emitted and a dirty-scope
  // reconcile is triggered.  Used by: updater.js, backfillService.js, compliance scan, assetPolicy.js.
  LOCF_STREAK_WARN_SESSIONS: 3,

  // Missing market-session rows in a contiguous gap before a coverage gap warning is raised.
  // Used by: compliance scan.
  MISSING_WARN_SESSIONS: 3,

  // Maximum market-session lag from the latest row before the display day-change fallback is
  // considered "stale" and zeroed out on the dashboard / investment detail view.
  // MUST equal LOCF_STREAK_WARN_SESSIONS so display staleness aligns with data-quality policy.
  // Used by: dashboard.js, investments.js resolveDisplayDayChangeFromRows.
  DAY_CHANGE_FALLBACK_MAX_LAG_SESSIONS: 3,

  // FOREIGN_STOCK gets a higher LOCF streak tolerance because after-hours data is
  // attributed to the next trading day, meaning one LOCF per session boundary is
  // structurally expected during US after-hours (1:30 AM–5:30 AM IST window).
  // Warn only when 5+ consecutive weekday sessions have no LIVE row.
  // Used by: compliance detectLocfQualityIssues, updater LOCF streak check for FS.
  FOREIGN_STOCK_LOCF_STREAK_WARN_SESSIONS: 5,
});

module.exports = FRESHNESS_POLICY;
