// API route for compliance scan and gap reporting
const express = require('express');
const router = express.Router();
const { scanAndRepairComplianceGaps, getOpenGaps } = require('../services/compliance/complianceScanService');

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
    const gaps = getOpenGaps();
    const status = gaps.length === 0 ? 'ok' : 'warning';
    res.json({ status, gaps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
