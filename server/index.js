const { applyEnvDefaults } = require('./config/envDefaults');
applyEnvDefaults();

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const { getDb, initializeDb, ensureNPSFundCodeMigration, ensureRemoveCombinedAggregatesMigration } = require('./db/schema');
const { startScheduler } = require('./services/scheduler');
const { requireAuth } = require('./middleware/auth');
const { logAppInfo, logAppError, getUnifiedLogPathForDate, installConsoleCapture } = require('./services/appLogger');

const app = express();
const PORT = process.env.PORT || 4000;
const appMode = String(process.env.APP_MODE || 'production').toLowerCase();
const isProduction = appMode !== 'dev' && appMode !== 'development' && appMode !== 'test';
const schedulerEnabled = process.env.ENABLE_SCHEDULER === 'true';

installConsoleCapture();

// Initialize database
const db = getDb();
initializeDb(db);
ensureNPSFundCodeMigration(db);
ensureRemoveCombinedAggregatesMigration(db);

// Middleware
app.use(cors());
app.use(express.json());

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(session({
  name: 'itrack.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// API Routes
app.use('/api/auth', require('./routes/auth')(db));
app.use('/api', requireAuth);

app.use('/api/portfolios', require('./routes/portfolios')(db));
app.use('/api/investments', require('./routes/investments')(db));
app.use('/api/transactions', require('./routes/transactions')(db));
app.use('/api/dashboard', require('./routes/dashboard')(db));
app.use('/api/utils', require('./routes/utils')(db));
app.use('/api/cas', require('./routes/cas')(db));
app.use('/api/stocks', require('./routes/stocks')(db));
app.use('/api/nps', require('./routes/nps')(db));
app.use('/api/ppf', require('./routes/ppf')(db));
app.use('/api/pf', require('./routes/pf')(db));
app.use('/api/expenses', require('./routes/expenses')(db));
app.use('/api/tax', require('./routes/tax')(db));
// Compliance API (gap detection and repair tracking)
app.use('/api/compliance', require('./routes/compliance'));
// Holidays API (no auth required for listing holidays/weekends)
app.use('/api/holidays', require('./routes/holidays'));

// Serve static files in production mode
if (isProduction) {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  logAppError('Server error', {
    path: req?.originalUrl,
    method: req?.method,
    error: err?.message || String(err),
  });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Investment Tracker API running on http://localhost:${PORT}`);
  logAppInfo('Investment Tracker API started', {
    port: Number(PORT),
    appMode,
    schedulerEnabled,
    logFile: getUnifiedLogPathForDate(),
  });

  // Start scheduled price updates only when explicitly enabled.
  if (schedulerEnabled) {
    startScheduler(db);
  } else {
    console.log('[Scheduler] Disabled (set ENABLE_SCHEDULER=true to enable).');
    logAppInfo('[Scheduler] Disabled (set ENABLE_SCHEDULER=true to enable).');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  logAppInfo('Received SIGINT, shutting down');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logAppInfo('Received SIGTERM, shutting down');
  db.close();
  process.exit(0);
});
