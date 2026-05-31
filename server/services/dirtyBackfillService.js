const { toIsoDate, todayIso } = require('./dateUtils');

const PROVIDENT_TYPES = new Set(['PPF', 'SSY', 'PF']);

function startOfMonth(isoDate) {
  const d = toIsoDate(isoDate);
  return d ? `${d.slice(0, 7)}-01` : null;
}

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

function mergeDelimitedValues(existingValue, nextValue, delimiter = ' | ') {
  const parts = [];
  const seen = new Set();

  const add = (value) => {
    if (!value) return;
    const tokens = String(value)
      .split(delimiter)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      parts.push(token);
    }
  };

  add(existingValue);
  add(nextValue);
  return parts.length ? parts.join(delimiter) : null;
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

  const existingRows = db.prepare(`
    SELECT id, dirty_from_date, dirty_reason, source_event_id, status
    FROM dirty_backfill_scope
    WHERE COALESCE(investment_id, 0) = COALESCE(?, 0)
      AND COALESCE(portfolio_id, 0) = COALESCE(?, 0)
      AND status IN ('pending', 'running', 'failed')
    ORDER BY CASE WHEN status IN ('pending', 'running') THEN 0 ELSE 1 END ASC, id DESC
  `).get(investmentId, portfolioId);

  if (existingRows) {
    const rows = db.prepare(`
      SELECT id, dirty_from_date, dirty_reason, source_event_id, status
      FROM dirty_backfill_scope
      WHERE COALESCE(investment_id, 0) = COALESCE(?, 0)
        AND COALESCE(portfolio_id, 0) = COALESCE(?, 0)
        AND status IN ('pending', 'running', 'failed')
      ORDER BY CASE WHEN status IN ('pending', 'running') THEN 0 ELSE 1 END ASC, id DESC
    `).all(investmentId, portfolioId);

    const primary = rows[0];
    let nextDirtyFromDate = dirtyDate;
    let mergedReason = reason || null;
    let mergedSourceEventId = sourceEventId || null;
    for (const row of rows) {
      nextDirtyFromDate = minDate(nextDirtyFromDate, row.dirty_from_date);
      mergedReason = mergeDelimitedValues(mergedReason, row.dirty_reason);
      mergedSourceEventId = mergeDelimitedValues(mergedSourceEventId, row.source_event_id);
    }

    db.prepare(`
      UPDATE dirty_backfill_scope
      SET dirty_from_date = ?,
          dirty_reason = ?,
          source_event_id = ?,
          status = 'pending',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextDirtyFromDate, mergedReason, mergedSourceEventId, primary.id);

    if (rows.length > 1) {
      const duplicateIds = rows.slice(1).map((row) => row.id);
      const placeholders = duplicateIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM dirty_backfill_scope WHERE id IN (${placeholders})`).run(...duplicateIds);
    }
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

  const assetTypeCache = new Map();
  const resolveAssetType = (investmentId) => {
    if (investmentId == null) return null;
    if (assetTypeCache.has(investmentId)) return assetTypeCache.get(investmentId);
    const row = db.prepare('SELECT asset_type FROM investments WHERE id = ?').get(investmentId);
    const type = row?.asset_type || null;
    assetTypeCache.set(investmentId, type);
    return type;
  };

  let count = 0;
  for (const tx of transactions) {
    const assetType = resolveAssetType(tx.investment_id ?? null);
    const baseDate = tx.transaction_date;
    const dirtyFromDate = PROVIDENT_TYPES.has(assetType) ? startOfMonth(baseDate) : baseDate;
    const dirtyDate = markScopeDirty(db, {
      investmentId: tx.investment_id ?? null,
      portfolioId: tx.portfolio_id ?? null,
      dirtyFromDate,
      reason,
      sourceEventId,
    });
    if (dirtyDate) count += 1;
  }
  return count;
}

function markDirtyForAssetTypeFromDate(db, assetType, dirtyFromDate, reason, sourceEventId = null) {
  const normalizedBase = normalizeDirtyDate(dirtyFromDate);
  const normalized = PROVIDENT_TYPES.has(assetType) ? startOfMonth(normalizedBase) : normalizedBase;
  if (!normalized || !assetType) return 0;

  const rows = db.prepare(`
    SELECT DISTINCT i.id AS investment_id, t.portfolio_id, ? AS transaction_date
    FROM investments i
    LEFT JOIN transactions t ON t.investment_id = i.id
    WHERE i.asset_type = ?
  `).all(normalized, assetType);

  return markDirtyFromTransactions(db, rows, reason, sourceEventId);
}

function markAllTrackedInvestmentsDirtyFromDate(db, dirtyFromDate, reason, sourceEventId = null) {
  const normalized = normalizeDirtyDate(dirtyFromDate);
  if (!normalized) return 0;

  const rows = db.prepare(`
    SELECT DISTINCT i.id AS investment_id, t.portfolio_id
    FROM investments i
    LEFT JOIN transactions t ON t.investment_id = i.id
    WHERE i.is_active != 0
      AND COALESCE(i.exclude_from_tracking, 0) != 1
      AND t.portfolio_id IS NOT NULL
  `).all();

  let count = 0;
  for (const row of rows) {
    const dirtyDate = markScopeDirty(db, {
      investmentId: row.investment_id,
      portfolioId: row.portfolio_id,
      dirtyFromDate: normalized,
      reason,
      sourceEventId,
    });
    if (dirtyDate) count += 1;
  }

  return count;
}

function getPendingDirtyScopes(db, runDate = todayIso(), options = {}) {
  const effectiveRunDate = normalizeDirtyDate(runDate) || todayIso();
  const maxScopes = Number.isFinite(Number(options.maxScopes))
    ? Math.max(0, Math.floor(Number(options.maxScopes)))
    : 0;

  const query = `
    SELECT id, investment_id, portfolio_id, dirty_from_date, dirty_reason, source_event_id, status, created_at, updated_at
    FROM dirty_backfill_scope
    WHERE status IN ('pending', 'running', 'failed')
      AND dirty_from_date <= ?
    ORDER BY dirty_from_date ASC, id ASC
    ${maxScopes > 0 ? `LIMIT ${maxScopes}` : ''}
  `;

  return db.prepare(query).all(effectiveRunDate);
}

async function runDirtyBackfillPreflight(db, runDate = todayIso(), options = {}) {
  const { runBackfillInTwoSteps } = require('./backfillService');
  const effectiveRunDate = normalizeDirtyDate(runDate) || todayIso();
  const maxScopes = Number.isFinite(Number(options.maxScopes))
    ? Math.max(0, Math.floor(Number(options.maxScopes)))
    : 0;
  const scopes = getPendingDirtyScopes(db, effectiveRunDate, { maxScopes });
  if (!scopes.length) {
    clearBackfillProgress(db);
    return {
      runDate: effectiveRunDate,
      pending: 0,
      processed: 0,
      skippedFuture: 0,
      scopeLimitApplied: maxScopes > 0 ? maxScopes : null,
    };
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
    const result = await runBackfillInTwoSteps(db, { runDate: effectiveRunDate, scopes });

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
      scopeLimitApplied: maxScopes > 0 ? maxScopes : null,
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

async function runBackfillInTwoSteps(db, { runDate, scopes }) {
  const { backfillNPSHistoricalNAV } = require('./backfillService');
  const { logBackfillInfo } = require('./appLogger');

  let processed = 0;
  let rowsWritten = 0;
  let skippedFuture = 0;

  for (const scope of scopes) {
    const { investment_id: investmentId, dirty_from_date: dirtyFromDate } = scope;

    const investment = db.prepare('SELECT id, asset_type FROM investments WHERE id = ?').get(investmentId);
    if (!investment) {
      logBackfillInfo(`[Backfill] Skipping unknown investment ${investmentId}`);
      continue;
    }

    if (investment.asset_type === 'NPS') {
      await backfillNPSHistoricalNAV(db, investmentId, dirtyFromDate, runDate);
      processed += 1;
      continue;
    }

    // Existing backfill logic for other asset types...
  }

  return { processed, rowsWritten, skippedFuture };
}

function markNPSDirty(db, investmentId, dirtyFromDate, reason = 'NPS data update', sourceEventId = null) {
  const normalizedDate = normalizeDirtyDate(dirtyFromDate);
  if (!normalizedDate) return;

  markScopeDirty(db, {
    investmentId,
    portfolioId: null,
    dirtyFromDate: normalizedDate,
    reason,
    sourceEventId,
  });
}

function markNPSInvestmentsDirtyFromTransactions(db) {
  const transactions = db.prepare(`
    SELECT DISTINCT investment_id, MIN(transaction_date) AS earliest_date
    FROM transactions
    WHERE investment_id IN (
      SELECT id FROM investments WHERE asset_type = 'NPS'
    )
    GROUP BY investment_id
  `).all();

  for (const { investment_id: investmentId, earliest_date: dirtyFromDate } of transactions) {
    markNPSDirty(db, investmentId, dirtyFromDate, 'Reprocessing NPS daily_values');
  }
}

module.exports = {
  clearBackfillProgress,
  getPendingDirtyScopes,
  markAllTrackedInvestmentsDirtyFromDate,
  markDirtyForAssetTypeFromDate,
  markDirtyFromTransactions,
  markScopeDirty,
  runDirtyBackfillPreflight,
  setBackfillProgress,
};
