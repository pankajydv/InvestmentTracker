const { logAppInfo, logAppError } = require('./appLogger');

function normalizeDate(value) {
  if (!value) return null;
  const date = String(value).split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function clampRange(fromDate, toDate) {
  const from = normalizeDate(fromDate);
  const to = normalizeDate(toDate);
  if (!from || !to) return null;
  if (from <= to) return { from, to };
  return { from: to, to: from };
}

function ensureRepairTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS historical_price_repair_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      reason TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      source_event_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_hist_price_repair_status_priority
      ON historical_price_repair_scope(status, priority, created_at);

    CREATE INDEX IF NOT EXISTS idx_hist_price_repair_lookup
      ON historical_price_repair_scope(instrument_type, symbol, from_date, to_date, status);
  `);
}

function findOverlappingPendingOrRunning(db, instrumentType, symbol, fromDate, toDate) {
  return db.prepare(`
    SELECT id
    FROM historical_price_repair_scope
    WHERE instrument_type = ?
      AND symbol = ?
      AND status IN ('pending', 'running')
      AND from_date <= ?
      AND to_date >= ?
    LIMIT 1
  `).get(instrumentType, symbol, toDate, fromDate);
}

function enqueueGap(db, gap) {
  if (!db || !gap) return { enqueued: false, reason: 'invalid-input' };

  const instrumentType = String(gap.instrumentType || '').trim();
  const symbol = String(gap.symbol || '').trim();
  const range = clampRange(gap.fromDate, gap.toDate);
  if (!instrumentType || !symbol || !range) {
    return { enqueued: false, reason: 'invalid-gap' };
  }

  ensureRepairTable(db);

  const existing = findOverlappingPendingOrRunning(db, instrumentType, symbol, range.from, range.to);
  if (existing) {
    return { enqueued: false, reason: 'overlap-exists', existingId: existing.id };
  }

  const priority = Number.isFinite(Number(gap.priority)) ? Math.max(1, Math.floor(Number(gap.priority))) : 100;
  const reason = gap.reason ? String(gap.reason) : null;
  const sourceEventId = gap.sourceEventId ? String(gap.sourceEventId) : null;

  const result = db.prepare(`
    INSERT INTO historical_price_repair_scope (
      instrument_type, symbol, from_date, to_date, reason, priority, source_event_id, status, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
  `).run(instrumentType, symbol, range.from, range.to, reason, priority, sourceEventId);

  return { enqueued: true, id: Number(result.lastInsertRowid) };
}

function enqueueGapsBatch(db, gaps) {
  if (!db || !Array.isArray(gaps) || gaps.length === 0) {
    return { requested: 0, enqueued: 0, skipped: 0, ids: [] };
  }

  ensureRepairTable(db);
  const tx = db.transaction((rows) => {
    const out = { requested: rows.length, enqueued: 0, skipped: 0, ids: [] };
    for (const row of rows) {
      const res = enqueueGap(db, row);
      if (res.enqueued) {
        out.enqueued += 1;
        out.ids.push(res.id);
      } else {
        out.skipped += 1;
      }
    }
    return out;
  });

  return tx(gaps);
}

function claimPendingBatch(db, limit = 25) {
  ensureRepairTable(db);
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 25));

  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id
      FROM historical_price_repair_scope
      WHERE status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `).all(boundedLimit);

    if (!rows.length) return [];

    const ids = rows.map((r) => Number(r.id));
    const placeholders = ids.map(() => '?').join(',');

    db.prepare(`
      UPDATE historical_price_repair_scope
      SET status = 'running',
          attempts = attempts + 1,
          updated_at = datetime('now')
      WHERE id IN (${placeholders})
    `).run(...ids);

    return db.prepare(`
      SELECT *
      FROM historical_price_repair_scope
      WHERE id IN (${placeholders})
      ORDER BY priority ASC, created_at ASC
    `).all(...ids);
  });

  return tx();
}

function markCompleted(db, id) {
  ensureRepairTable(db);
  db.prepare(`
    UPDATE historical_price_repair_scope
    SET status = 'completed',
        completed_at = datetime('now'),
        updated_at = datetime('now'),
        last_error = NULL
    WHERE id = ?
  `).run(id);
}

function markFailed(db, id, errorMessage) {
  ensureRepairTable(db);
  db.prepare(`
    UPDATE historical_price_repair_scope
    SET status = 'failed',
        last_error = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(String(errorMessage || 'unknown-error'), id);
}

function markRetryPending(db, id, errorMessage) {
  ensureRepairTable(db);
  db.prepare(`
    UPDATE historical_price_repair_scope
    SET status = 'pending',
        last_error = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(String(errorMessage || 'unknown-error'), id);
}

function summarizeRepairQueue(db) {
  ensureRepairTable(db);
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM historical_price_repair_scope
    GROUP BY status
  `).all();

  const summary = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  for (const row of counts) {
    const key = String(row.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] = Number(row.count || 0);
    }
  }

  return summary;
}

function logRepairQueueSummary(db, label) {
  try {
    const summary = summarizeRepairQueue(db);
    logAppInfo(`[HistPriceRepair] ${label}`, summary);
    return summary;
  } catch (e) {
    logAppError('[HistPriceRepair] Failed to summarize queue', { error: e.message });
    return null;
  }
}

module.exports = {
  ensureRepairTable,
  enqueueGap,
  enqueueGapsBatch,
  claimPendingBatch,
  markCompleted,
  markFailed,
  markRetryPending,
  summarizeRepairQueue,
  logRepairQueueSummary,
};
