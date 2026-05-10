const { backfillDirtyScopes, toIsoDate, todayIso } = require('./backfillService');

function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function normalizeDirtyDate(inputDate) {
  const parsed = toIsoDate(inputDate);
  if (!parsed) return null;
  return parsed;
}

function upsertConfig(db, key, value) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, String(value));
}

function setBackfillProgress(db, progress = {}) {
  const payload = {
    phase: progress.phase || 'idle',
    total: Number(progress.total || 0),
    completed: Number(progress.completed || 0),
    current: progress.current || null,
    message: progress.message || null,
    runDate: progress.runDate || null,
    startedAt: progress.startedAt || null,
    updatedAt: new Date().toISOString(),
  };

  upsertConfig(db, 'backfill_progress', JSON.stringify(payload));
  if (payload.runDate) upsertConfig(db, 'backfill_watermark', payload.runDate);
}

function clearBackfillProgress(db) {
  setBackfillProgress(db, { phase: 'idle', total: 0, completed: 0, current: null, message: null, runDate: null, startedAt: null });
}

function markScopeDirty(db, { investmentId = null, portfolioId = null, dirtyFromDate, reason = null, sourceEventId = null }) {
  const dirtyDate = normalizeDirtyDate(dirtyFromDate);
  if (!dirtyDate) return null;

  const existing = db.prepare(`
    SELECT id, dirty_from_date
    FROM dirty_backfill_scope
    WHERE COALESCE(investment_id, 0) = COALESCE(?, 0)
      AND COALESCE(portfolio_id, 0) = COALESCE(?, 0)
      AND status IN ('pending', 'running')
    ORDER BY id DESC
    LIMIT 1
  `).get(investmentId, portfolioId);

  if (existing) {
    const nextDirtyFromDate = minDate(existing.dirty_from_date, dirtyDate);
    db.prepare(`
      UPDATE dirty_backfill_scope
      SET dirty_from_date = ?,
          dirty_reason = COALESCE(?, dirty_reason),
          source_event_id = COALESCE(?, source_event_id),
          status = 'pending',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextDirtyFromDate, reason, sourceEventId, existing.id);
  } else {
    db.prepare(`
      INSERT INTO dirty_backfill_scope (investment_id, portfolio_id, dirty_from_date, dirty_reason, source_event_id, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(investmentId, portfolioId, dirtyDate, reason, sourceEventId);
  }

  if (investmentId != null) {
    const inv = db.prepare('SELECT dirty_from_date FROM investments WHERE id = ?').get(investmentId);
    if (inv) {
      const nextInvDirty = minDate(inv.dirty_from_date, dirtyDate);
      db.prepare(`
        UPDATE investments
        SET is_dirty_daily_values = 1,
            dirty_from_date = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(nextInvDirty, investmentId);
    }
  }

  return dirtyDate;
}

function markDirtyFromTransactions(db, transactions, reason, sourceEventId = null) {
  if (!Array.isArray(transactions) || !transactions.length) return 0;

  let count = 0;
  for (const tx of transactions) {
    const dirtyDate = markScopeDirty(db, {
      investmentId: tx.investment_id ?? null,
      portfolioId: tx.portfolio_id ?? null,
      dirtyFromDate: tx.transaction_date,
      reason,
      sourceEventId,
    });
    if (dirtyDate) count += 1;
  }
  return count;
}

function markDirtyForAssetTypeFromDate(db, assetType, dirtyFromDate, reason, sourceEventId = null) {
  const normalized = normalizeDirtyDate(dirtyFromDate);
  if (!normalized || !assetType) return 0;

  const rows = db.prepare(`
    SELECT DISTINCT i.id AS investment_id, t.portfolio_id, ? AS transaction_date
    FROM investments i
    LEFT JOIN transactions t ON t.investment_id = i.id
    WHERE i.asset_type = ?
  `).all(normalized, assetType);

  return markDirtyFromTransactions(db, rows, reason, sourceEventId);
}

function getPendingDirtyScopes(db, runDate = todayIso()) {
  const effectiveRunDate = normalizeDirtyDate(runDate) || todayIso();
  return db.prepare(`
    SELECT id, investment_id, portfolio_id, dirty_from_date, dirty_reason, source_event_id, status, created_at, updated_at
    FROM dirty_backfill_scope
    WHERE status IN ('pending', 'running')
      AND dirty_from_date <= ?
    ORDER BY dirty_from_date ASC, id ASC
  `).all(effectiveRunDate);
}

async function runDirtyBackfillPreflight(db, runDate = todayIso()) {
  const effectiveRunDate = normalizeDirtyDate(runDate) || todayIso();
  const scopes = getPendingDirtyScopes(db, effectiveRunDate);
  if (!scopes.length) {
    clearBackfillProgress(db);
    return { runDate: effectiveRunDate, pending: 0, processed: 0, skippedFuture: 0 };
  }

  const scopeIds = scopes.map((s) => s.id);
  const markRunning = db.prepare(`
    UPDATE dirty_backfill_scope
    SET status = 'running', updated_at = datetime('now')
    WHERE id = ?
  `);
  for (const id of scopeIds) markRunning.run(id);

  setBackfillProgress(db, {
    phase: 'running',
    total: scopes.length,
    completed: 0,
    current: scopes[0] ? {
      investment_id: scopes[0].investment_id,
      portfolio_id: scopes[0].portfolio_id,
      dirty_from_date: scopes[0].dirty_from_date,
      dirty_reason: scopes[0].dirty_reason,
    } : null,
    message: 'Backfill started',
    runDate: effectiveRunDate,
    startedAt: new Date().toISOString(),
  });

  try {
    const result = await backfillDirtyScopes(db, scopes, { runDate: effectiveRunDate });

    const markDone = db.prepare(`
      UPDATE dirty_backfill_scope
      SET status = 'completed', updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const id of scopeIds) markDone.run(id);

    const clearDirty = db.prepare(`
      UPDATE investments
      SET is_dirty_daily_values = 0, dirty_from_date = NULL, updated_at = datetime('now')
      WHERE id IN (
        SELECT DISTINCT investment_id FROM dirty_backfill_scope WHERE id = ? AND investment_id IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM dirty_backfill_scope d
        WHERE d.investment_id = investments.id
          AND d.status IN ('pending', 'running')
      )
    `);
    for (const id of scopeIds) clearDirty.run(id);

    setBackfillProgress(db, {
      phase: 'completed',
      total: scopes.length,
      completed: scopes.length,
      current: null,
      message: 'Backfill completed',
      runDate: effectiveRunDate,
      startedAt: new Date().toISOString(),
    });

    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES ('backfill_watermark', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(effectiveRunDate);

    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES ('backfill_last_result', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(JSON.stringify({
      runDate: effectiveRunDate,
      pending: scopes.length,
      processed: result.processed || 0,
      rowsWritten: result.rowsWritten || 0,
      skippedFuture: result.skippedFuture || 0,
      completedAt: new Date().toISOString(),
    }));

    return {
      runDate: effectiveRunDate,
      pending: scopes.length,
      processed: result.processed || 0,
      skippedFuture: result.skippedFuture || 0,
    };
  } catch (e) {
    setBackfillProgress(db, {
      phase: 'failed',
      total: scopes.length,
      completed: 0,
      current: null,
      message: e.message,
      runDate: effectiveRunDate,
      startedAt: new Date().toISOString(),
    });

    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES ('backfill_last_error', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(`${new Date().toISOString()} ${e.message}`);

    const markFailed = db.prepare(`
      UPDATE dirty_backfill_scope
      SET status = 'failed', updated_at = datetime('now'), dirty_reason = COALESCE(dirty_reason, '') || ?
      WHERE id = ?
    `);
    for (const id of scopeIds) markFailed.run(` | preflight failed: ${e.message}`, id);
    throw e;
  }
}

module.exports = {
  clearBackfillProgress,
  getPendingDirtyScopes,
  markDirtyForAssetTypeFromDate,
  markDirtyFromTransactions,
  markScopeDirty,
  runDirtyBackfillPreflight,
  setBackfillProgress,
};
