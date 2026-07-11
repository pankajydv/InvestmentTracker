// API route for compliance scan and gap reporting
const express = require('express');
const router = express.Router();
const { scanAndRepairComplianceGaps, getOpenGaps } = require('../services/compliance/complianceScanService');
const { getDb } = require('../db/schema');
const { isSnapshotEnabled, getDataVersion, getCachedSnapshot, putSnapshot } = require('../services/dashboardSnapshotService');

// POST /api/compliance/scan - Trigger a compliance scan and record any gaps
router.post('/scan', (req, res) => {
  try {
    const requestedMode = String((req.body && req.body.mode) || req.query.mode || 'full').toLowerCase();
    const mode = requestedMode === 'incremental' || requestedMode === 'fast' ? 'incremental' : 'full';
    const result = scanAndRepairComplianceGaps({ mode });
    res.json({
      success: true,
      mode: result.mode,
      run_date: result.runDate,
      window: result.window,
      gaps_detected: result.gapsDetected,
      repairs_enqueued: result.repairsEnqueued,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/compliance/open-gaps - Get all open gaps for dashboard display
router.get('/open-gaps', (req, res) => {
  try {
    let db = null;
    try { db = getDb(); } catch (_e) { db = null; }
    const cacheVersion = (db && isSnapshotEnabled()) ? getDataVersion(db) : null;
    const cacheKey = cacheVersion != null ? 'open-gaps' : null;
    if (db && cacheKey) {
      const cached = getCachedSnapshot(db, cacheKey, cacheVersion);
      if (cached) return res.json(cached);
    }
    const gaps = getOpenGaps();
    const status = gaps.length === 0 ? 'ok' : 'warning';
    const payload = { status, gaps };
    if (db && cacheKey) putSnapshot(db, cacheKey, cacheVersion, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
