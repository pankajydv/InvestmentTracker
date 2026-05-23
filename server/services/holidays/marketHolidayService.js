// Service for managing market holidays and weekends
const { getDb } = require('../../db/schema');

function withDb(dbOverride, fn) {
  const db = dbOverride || getDb();
  const shouldCloseDb = !dbOverride;
  try {
    return fn(db);
  } finally {
    if (shouldCloseDb) db.close();
  }
}

/**
 * Get all market holidays for a given year
 */
function getMarketHolidays(year, dbOverride = null) {
  return withDb(dbOverride, (db) => db.prepare('SELECT date, description FROM market_holidays WHERE year = ? ORDER BY date').all(year));
}

/**
 * Add or update a market holiday
 */
function upsertMarketHoliday(date, description, year, dbOverride = null) {
  return withDb(dbOverride, (db) => db.prepare('INSERT OR REPLACE INTO market_holidays (date, description, year) VALUES (?, ?, ?)').run(date, description, year));
}

/**
 * Get all weekends for a given year
 */
function getWeekends(year) {
  const weekends = [];
  const start = new Date(`${year}-01-01`);
  const end = new Date(`${year}-12-31`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) {
      weekends.push({ date: d.toISOString().slice(0, 10), description: d.getDay() === 0 ? 'Sunday' : 'Saturday' });
    }
  }
  return weekends;
}

module.exports = {
  getMarketHolidays,
  upsertMarketHoliday,
  getWeekends,
};
