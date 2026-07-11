/**
 * XIRR Cache Service
 * Pre-calculates and caches XIRR values after scheduler price updates.
 * Eliminates expensive binary-search XIRR computation on dashboard requests.
 */

const { calculateIntervalXIRR } = require('./xirrCalculator');
const { todayIso, addDaysIso } = require('./dateUtils');
const { logAppInfo, logAppWarn, logAppError } = require('./appLogger');

const CACHE_INTERVALS = [
  { key: '1D', label: 'Yesterday to Today' },
  { key: 'YD', label: 'Yesterday' },
  { key: '1W', label: 'Last 7 days' },
];

/**
 * Initialize XIRR cache table if it doesn't exist
 */
function ensureXirrCacheTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS xirr_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT UNIQUE NOT NULL,
      portfolio_id INTEGER,
      interval TEXT NOT NULL,
      xirr_value REAL,
      interval_change REAL,
      interval_change_pct REAL,
      opening_value REAL,
      closing_value REAL,
      computed_at TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      source TEXT DEFAULT 'scheduler',
      created_at TEXT DEFAULT (datetime('now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_xirr_cache_key ON xirr_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_xirr_cache_portfolio ON xirr_cache(portfolio_id, interval);
    CREATE INDEX IF NOT EXISTS idx_xirr_cache_valid ON xirr_cache(valid_until);
  `);
}

/**
 * Generate cache key for a portfolio + interval combination
 */
function generateCacheKey(portfolioId, interval) {
  const portKey = portfolioId === null || portfolioId === undefined ? 'all' : String(portfolioId);
  return `xirr_${portKey}_${interval}`.toLowerCase();
}

/**
 * Parse interval key (1D, YD, 1W, etc.) into from/to dates
 */
function getIntervalDates(interval, baseDate = null) {
  const today = baseDate ? new Date(baseDate) : new Date();
  const todayStr = today.toISOString().split('T')[0];
  
  let fromDate, toDate;
  
  switch (String(interval || '').toUpperCase()) {
    case '1D':
      // Yesterday to today
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      fromDate = yesterday.toISOString().split('T')[0];
      toDate = todayStr;
      break;
      
    case 'YD':
      // Only yesterday
      const yestOnly = new Date(today);
      yestOnly.setDate(yestOnly.getDate() - 1);
      fromDate = yestOnly.toISOString().split('T')[0];
      toDate = fromDate;
      break;
      
    case '1W':
      // Last 7 days
      const week = new Date(today);
      week.setDate(week.getDate() - 7);
      fromDate = week.toISOString().split('T')[0];
      toDate = todayStr;
      break;
      
    default:
      throw new Error(`Unsupported interval for caching: ${interval}`);
  }
  
  return { fromDate, toDate };
}

/**
 * Check if cached XIRR is still valid
 * Valid if computed after all relevant data changes
 */
function isCacheValid(db, cacheKey, lastUpdateTime) {
  const cached = db.prepare('SELECT valid_until FROM xirr_cache WHERE cache_key = ?').get(cacheKey);
  if (!cached) return false;
  
  const validUntil = new Date(cached.valid_until).getTime();
  const now = Date.now();
  
  // Cache is valid if we haven't passed the expiration
  return now < validUntil && cached.valid_until > new Date(lastUpdateTime).toISOString();
}

/**
 * Get cached XIRR value if valid
 */
function getCachedXirr(db, cacheKey) {
  const row = db.prepare(`
    SELECT 
      xirr_value,
      interval_change,
      interval_change_pct,
      opening_value,
      closing_value,
      computed_at
    FROM xirr_cache
    WHERE cache_key = ? AND valid_until > datetime('now')
  `).get(cacheKey);
  
  if (!row) return null;
  
  return {
    xirr_pct: row.xirr_value,
    interval_change: row.interval_change,
    interval_change_pct: row.interval_change_pct,
    opening_value: row.opening_value,
    closing_value: row.closing_value,
    confidence: 'cached',
    cached_at: row.computed_at,
  };
}

/**
 * Store XIRR in cache
 */
function cacheXirr(db, cacheKey, portfolioId, interval, xirrResult, validForHours = 24) {
  try {
    const now = new Date();
    const computedAt = now.toISOString();
    const validUntil = new Date(now.getTime() + validForHours * 3600000).toISOString();
    
    db.prepare(`
      INSERT OR REPLACE INTO xirr_cache (
        cache_key,
        portfolio_id,
        interval,
        xirr_value,
        interval_change,
        interval_change_pct,
        opening_value,
        closing_value,
        computed_at,
        valid_until,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduler')
    `).run(
      cacheKey,
      portfolioId,
      interval,
      xirrResult.xirr_pct || null,
      xirrResult.interval_change || 0,
      xirrResult.interval_change_pct || 0,
      xirrResult.opening_value || 0,
      xirrResult.closing_value || 0,
      computedAt,
      validUntil
    );
  } catch (err) {
    logAppWarn('Failed to cache XIRR', {
      cacheKey,
      error: err.message,
    });
  }
}

/**
 * Invalidate XIRR cache for a portfolio
 * Called when transactions are edited/added
 */
function invalidatePortfolioXirrCache(db, portfolioId = null) {
  try {
    if (portfolioId === null || portfolioId === undefined) {
      // Invalidate everything, including the combined (portfolio_id IS NULL) rows.
      db.prepare('DELETE FROM xirr_cache').run();
    } else {
      // Invalidate the specific portfolio AND the combined "all" rows, since the
      // combined view aggregates every portfolio and is stale after any change.
      db.prepare('DELETE FROM xirr_cache WHERE portfolio_id = ? OR portfolio_id IS NULL').run(portfolioId);
    }
  } catch (err) {
    logAppWarn('Failed to invalidate XIRR cache', {
      portfolioId,
      error: err.message,
    });
  }
}

/**
 * Pre-calculate and cache XIRR for all portfolios and specified intervals
 * Called by scheduler after price update completes
 */
async function preCalculateXirrCache(db, label = 'Manual') {
  try {
    logAppInfo(`[XIRR Cache] ${label}: Starting pre-calculation`, {});
    
    // Ensure cache table exists
    ensureXirrCacheTable(db);
    
    // Get all active portfolios
    const portfolios = db.prepare(`
      SELECT id FROM portfolios ORDER BY id ASC
    `).all();
    
    const results = [];
    let calculatedCount = 0;
    let errors = 0;
    
    // Pre-calculate for each portfolio + interval combination
    for (const portfolio of portfolios) {
      for (const intervalConfig of CACHE_INTERVALS) {
        try {
          const cacheKey = generateCacheKey(portfolio.id, intervalConfig.key);
          const { fromDate, toDate } = getIntervalDates(intervalConfig.key);
          
          const xirrResult = calculateIntervalXIRR(db, portfolio.id, fromDate, toDate);
          cacheXirr(db, cacheKey, portfolio.id, intervalConfig.key, xirrResult);
          
          calculatedCount++;
          results.push({
            portfolioId: portfolio.id,
            interval: intervalConfig.key,
            xirr: xirrResult.xirr_pct,
            cached: true,
          });
        } catch (err) {
          errors++;
          logAppWarn(`[XIRR Cache] ${label}: Failed to calculate for portfolio ${portfolio.id}, interval ${intervalConfig.key}`, {
            error: err.message,
          });
        }
      }
    }
    
    // Also pre-calculate for combined view (portfolio_id = null)
    for (const intervalConfig of CACHE_INTERVALS) {
      try {
        const cacheKey = generateCacheKey(null, intervalConfig.key);
        const { fromDate, toDate } = getIntervalDates(intervalConfig.key);
        
        const xirrResult = calculateIntervalXIRR(db, null, fromDate, toDate);
        cacheXirr(db, cacheKey, null, intervalConfig.key, xirrResult);
        
        calculatedCount++;
        results.push({
          portfolioId: 'all',
          interval: intervalConfig.key,
          xirr: xirrResult.xirr_pct,
          cached: true,
        });
      } catch (err) {
        errors++;
        logAppWarn(`[XIRR Cache] ${label}: Failed to calculate for combined view, interval ${intervalConfig.key}`, {
          error: err.message,
        });
      }
    }
    
    logAppInfo(`[XIRR Cache] ${label}: Pre-calculation completed`, {
      portfolioCount: portfolios.length,
      calculatedCount,
      errors,
      intervalsPerPortfolio: CACHE_INTERVALS.length,
    });
    
    return { success: true, calculatedCount, errors, results };
  } catch (err) {
    logAppError(`[XIRR Cache] ${label}: Pre-calculation failed`, {
      error: err.message,
      stack: err.stack,
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  ensureXirrCacheTable,
  generateCacheKey,
  getIntervalDates,
  isCacheValid,
  getCachedXirr,
  cacheXirr,
  invalidatePortfolioXirrCache,
  preCalculateXirrCache,
};
