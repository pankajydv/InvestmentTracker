const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb, initializeDb } = require('./db/schema');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 4000;

// Initialize database
const db = getDb();
initializeDb(db);

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/portfolios', require('./routes/portfolios')(db));
app.use('/api/investments', require('./routes/investments')(db));
app.use('/api/transactions', require('./routes/transactions')(db));
app.use('/api/dashboard', require('./routes/dashboard')(db));
app.use('/api/utils', require('./routes/utils')(db));
app.use('/api/cas', require('./routes/cas')(db));
app.use('/api/stocks', require('./routes/stocks')(db));

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Investment Tracker API running on http://localhost:${PORT}`);

  // Start scheduled price updates
  startScheduler(db);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
