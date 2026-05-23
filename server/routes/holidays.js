// API routes for market holidays and weekends
const express = require('express');
const router = express.Router();
const marketHolidayService = require('../services/holidays/marketHolidayService');

// GET /api/holidays/:year - List all market holidays for a year
router.get('/:year', (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (!year) return res.status(400).json({ error: 'Invalid year' });
  const holidays = marketHolidayService.getMarketHolidays(year);
  res.json({ holidays });
});

// GET /api/holidays/:year/weekends - List all weekends for a year
router.get('/:year/weekends', (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (!year) return res.status(400).json({ error: 'Invalid year' });
  const weekends = marketHolidayService.getWeekends(year);
  res.json({ weekends });
});

// POST /api/holidays/sync - Sync/populate holidays for a year
router.post('/sync', (req, res) => {
  const { year, holidays } = req.body;
  if (!year || !Array.isArray(holidays)) return res.status(400).json({ error: 'Invalid input' });
  holidays.forEach(h => {
    marketHolidayService.upsertMarketHoliday(h.date, h.description, year);
  });
  res.json({ success: true });
});

module.exports = router;
