const { toIsoDate, todayIso } = require('./dateUtils');

const PROVIDENT_TYPES = new Set(['PPF', 'SSY', 'PF']);
const EXITED_UNITS_EPSILON = 1e-6;

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

function addDaysIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
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
    SELECT
      i.id AS investment_id,
      t.portfolio_id,
      MAX(date(t.transaction_date)) AS max_txn_date,
      COALESCE(SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE i.is_active != 0
      AND COALESCE(i.exclude_from_tracking, 0) != 1
      AND t.portfolio_id IS NOT NULL
    GROUP BY i.id, t.portfolio_id
  `).all();

  let count = 0;
  for (const row of rows) {
    const maxTxnDate = toIsoDate(row.max_txn_date);
    const netUnits = Number(row.net_units || 0);
    const isExited = Math.abs(netUnits) <= EXITED_UNITS_EPSILON;

    // Source-side guard: don't enqueue scopes for exited holdings when dirty date is after exit.
    if (isExited && maxTxnDate && normalized > maxTxnDate) {
      continue;
    }

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

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function runDailyBootstrapDirtyScopeEnqueue(db, options = {}) {
  const runDate = normalizeDirtyDate(options.runDate) || todayIso();
  const lookbackDays = Math.max(1, Math.floor(Number(options.lookbackDays) || 2));
  const staleRunSeconds = Math.max(60, Math.floor(Number(options.staleRunSeconds) || 900));
  const trigger = String(options.trigger || 'unknown').trim() || 'unknown';
  const stateKey = 'daily_scope_bootstrap_state';
  const dirtyFromDate = addDaysIso(runDate, -lookbackDays);
  const nowIso = new Date().toISOString();

  const claimTx = db.transaction(() => {
    const row = db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1').get(stateKey);
    const state = parseJsonSafe(row?.value);

    if (state?.runDate === runDate && state?.status === 'completed') {
      return {
        shouldRun: false,
        reason: 'already-completed',
        runDate,
        dirtyFromDate,
      };
    }

    if (state?.runDate === runDate && state?.status === 'running') {
      const claimedAtMs = Date.parse(String(state?.claimedAt || ''));
      const isFresh = Number.isFinite(claimedAtMs) && (Date.now() - claimedAtMs) < (staleRunSeconds * 1000);
      if (isFresh) {
        return {
          shouldRun: false,
          reason: 'already-running',
          runDate,
          dirtyFromDate,
        };
      }
    }

    const attempt = Number(state?.runDate === runDate ? state?.attempt : 0) + 1;
    const nextState = {
      status: 'running',
      runDate,
      dirtyFromDate,
      lookbackDays,
      trigger,
      attempt,
      claimedAt: nowIso,
      updatedAt: nowIso,
      staleRunSeconds,
      lastResult: state?.lastResult || null,
    };

    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(stateKey, JSON.stringify(nextState));

    return {
      shouldRun: true,
      reason: 'claimed',
      runDate,
      dirtyFromDate,
      attempt,
      trigger,
      staleRunSeconds,
    };
  });

  const claim = claimTx();
  if (!claim.shouldRun) {
    return {
      runDate,
      dirtyFromDate,
      lookbackDays,
      attempted: false,
      status: claim.reason,
      enqueued: 0,
    };
  }

  try {
    const reason = 'daily-bootstrap-catchup';
    const sourceEventId = `daily-bootstrap:${runDate}`;
    const enqueued = markAllTrackedInvestmentsDirtyFromDate(db, dirtyFromDate, reason, sourceEventId);
    const completedAt = new Date().toISOString();
    const finalState = {
      status: 'completed',
      runDate,
      dirtyFromDate,
      lookbackDays,
      trigger,
      attempt: claim.attempt,
      claimedAt: nowIso,
      completedAt,
      updatedAt: completedAt,
      staleRunSeconds,
      lastResult: {
        status: 'completed',
        enqueued,
        completedAt,
      },
    };

    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(stateKey, JSON.stringify(finalState));

    return {
      runDate,
      dirtyFromDate,
      lookbackDays,
      attempted: true,
      status: 'completed',
      enqueued,
      attempt: claim.attempt,
      trigger,
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failedState = {
      status: 'failed',
      runDate,
      dirtyFromDate,
      lookbackDays,
      trigger,
      attempt: claim.attempt,
      claimedAt: nowIso,
      failedAt,
      updatedAt: failedAt,
      staleRunSeconds,
      lastResult: {
        status: 'failed',
        error: error?.message || String(error),
        failedAt,
      },
    };

    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(stateKey, JSON.stringify(failedState));

    throw error;
  }
}

function getEarliestPendingDirtyDateForAssetType(db, assetType, runDate = todayIso()) {
  const normalizedRunDate = normalizeDirtyDate(runDate) || todayIso();
  const normalizedAssetType = String(assetType || '').trim().toUpperCase();
  if (!normalizedAssetType) return null;

  const row = db.prepare(`
    SELECT MIN(s.dirty_from_date) AS min_dirty_from
    FROM dirty_backfill_scope s
    JOIN investments i ON i.id = s.investment_id
    WHERE s.status IN ('pending', 'running', 'failed')
      AND s.dirty_from_date <= ?
      AND i.asset_type = ?
      AND i.is_active != 0
      AND COALESCE(i.exclude_from_tracking, 0) != 1
  `).get(normalizedRunDate, normalizedAssetType);

  return normalizeDirtyDate(row?.min_dirty_from);
}

function markActiveTrackedForeignScopesDirtyFromDate(db, dirtyFromDate, reason, sourceEventId = null) {
  const normalized = normalizeDirtyDate(dirtyFromDate);
  if (!normalized) return 0;

  const rows = db.prepare(`
    SELECT
      i.id AS investment_id,
      t.portfolio_id,
      COALESCE(SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE i.asset_type = 'FOREIGN_STOCK'
      AND i.is_active != 0
      AND COALESCE(i.exclude_from_tracking, 0) != 1
      AND t.portfolio_id IS NOT NULL
      AND date(t.transaction_date) <= ?
    GROUP BY i.id, t.portfolio_id
    HAVING net_units > ?
    ORDER BY i.id ASC, t.portfolio_id ASC
  `).all(todayIso(), EXITED_UNITS_EPSILON);

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

  const query = `
    SELECT id, investment_id, portfolio_id, dirty_from_date, dirty_reason, source_event_id, status, created_at, updated_at
    FROM dirty_backfill_scope
    WHERE status IN ('pending', 'running', 'failed')
      AND dirty_from_date <= ?
    ORDER BY dirty_from_date ASC, id ASC
  `;

  return db.prepare(query).all(effectiveRunDate);
}

async function runDirtyBackfillPreflight(db, runDate = todayIso(), options = {}) {
  const { runBackfillInTwoSteps } = require('./backfillService');
  const effectiveRunDate = normalizeDirtyDate(runDate) || todayIso();
  const scopes = getPendingDirtyScopes(db, effectiveRunDate, options);
  if (!scopes.length) {
    clearBackfillProgress(db);
    return {
      runDate: effectiveRunDate,
      pending: 0,
      processed: 0,
      skippedFuture: 0,
      scopeLimitApplied: null,
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
      scopeLimitApplied: null,
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
  getEarliestPendingDirtyDateForAssetType,
  markAllTrackedInvestmentsDirtyFromDate,
  markActiveTrackedForeignScopesDirtyFromDate,
  markDirtyForAssetTypeFromDate,
  markDirtyFromTransactions,
  markScopeDirty,
  runDailyBootstrapDirtyScopeEnqueue,
  runDirtyBackfillPreflight,
  setBackfillProgress,
};
