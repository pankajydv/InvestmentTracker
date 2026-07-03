'use strict';

/**
 * RSU Vest Actualization
 * ----------------------
 * Turns a placeholder VEST transaction (only the RSU award schedule known:
 * vest date + gross_units) into a fully valued transaction using data we
 * already hold, so it can be surfaced for accept/edit/reject just like the
 * corporate-action suggestion flow.
 *
 * Derivation rules (validated against Fidelity for MSFT id 212):
 *  - FMV per share = closing price of the last trading session BEFORE the vest
 *    date, taken from market_price_cache. (e.g. Mon 2026-06-01 vest -> Fri
 *    2026-05-29 close = 450.24; Mon 2026-03-02 vest -> Fri 2026-02-27 = 392.74)
 *  - Withholding rate = carried forward from the most recent already-actualized
 *    vest (tax_withheld_units / gross_units). This is the employee's marginal
 *    perquisite tax rate and only steps at statutory surcharge thresholds, so it
 *    is stable within a regime. A mismatch on reconciliation must be surfaced,
 *    never silently applied.
 *  - tax_withheld_units = gross_units * withholding_rate
 *  - net units          = gross_units - tax_withheld_units
 *  - usd_amount (net)   = net_units * fmv
 *  - amount INR (net)   = net_units * fmv * fx_rate
 *
 * FX (USD/INR) on the vest date is not sourced here (it may require a network
 * fetch); callers pass it in. The pure derivation below is synchronous.
 */

const PLACEHOLDER_VEST_SQL = `
  gross_units IS NOT NULL AND gross_units > 0
  AND (
    units IS NULL OR units <= 0
    OR price_per_unit IS NULL OR price_per_unit <= 0
    OR fmv_per_unit IS NULL OR fmv_per_unit <= 0
    OR amount IS NULL OR amount <= 0
  )
`;

function round(value, decimals) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * FMV per share = last cached close strictly before the vest date for this
 * investment. Returns { fmv, sourceDate, source, lagDays } or null.
 */
function getPriorTradingClose(db, investmentId, vestDate) {
  const row = db.prepare(`
    SELECT date, close, source
    FROM market_price_cache
    WHERE investment_id = ?
      AND date < ?
      AND close IS NOT NULL
      AND close > 0
    ORDER BY date DESC
    LIMIT 1
  `).get(investmentId, vestDate);

  if (!row) return null;

  const msPerDay = 86400000;
  const lagDays = Math.round(
    (new Date(`${vestDate}T00:00:00.000Z`).getTime()
      - new Date(`${row.date}T00:00:00.000Z`).getTime()) / msPerDay
  );

  return {
    fmv: Number(row.close),
    sourceDate: row.date,
    source: row.source || null,
    lagDays,
  };
}

/**
 * Withholding rate carried forward from the most recent actualized vest for
 * this investment on or before the vest date. When `grossUnits` is provided we
 * prefer the most recent prior vest with the SAME gross_units, so the broker's
 * per-tranche share rounding is reproduced exactly (a rate inferred from a
 * different gross size drifts net units by ~0.001). Falls back to the most
 * recent vest of any size. Returns
 * { rate, basisDate, grossUnits, withheldUnits, matchedGross } or null.
 */
function getCarriedForwardWithholdingRate(db, investmentId, vestDate, grossUnits = null) {
  const pick = (matchGross) => db.prepare(`
    SELECT transaction_date, gross_units, tax_withheld_units
    FROM transactions
    WHERE investment_id = ?
      AND transaction_type = 'VEST'
      AND gross_units IS NOT NULL AND gross_units > 0
      AND tax_withheld_units IS NOT NULL AND tax_withheld_units > 0
      AND DATE(transaction_date) <= ?
      ${matchGross != null ? 'AND gross_units = ?' : ''}
    ORDER BY DATE(transaction_date) DESC, id DESC
    LIMIT 1
  `).get(...(matchGross != null ? [investmentId, vestDate, matchGross] : [investmentId, vestDate]));

  let matchedGross = false;
  let row = null;
  if (grossUnits != null) {
    row = pick(Number(grossUnits));
    if (row) matchedGross = true;
  }
  if (!row) row = pick(null);

  if (!row) return null;
  const gross = Number(row.gross_units);
  const withheld = Number(row.tax_withheld_units);
  if (!(gross > 0) || !(withheld >= 0)) return null;

  return {
    rate: withheld / gross,
    basisDate: String(row.transaction_date).slice(0, 10),
    grossUnits: gross,
    withheldUnits: withheld,
    matchedGross,
  };
}

/**
 * Pure derivation of the actualized values for one placeholder vest.
 * @param {object} params
 * @param {object} params.txn        placeholder transaction row (needs gross_units, transaction_date)
 * @param {number} params.fmv        FMV per share (USD)
 * @param {string} params.fmvSourceDate
 * @param {number} params.withholdingRate  e.g. 0.359
 * @param {number} params.fxRate     USD/INR on vest date
 * @param {object} [params.overrides] optional edited values
 * @returns {object} derived fields ready to write, plus the raw inputs used
 */
function computeVestValues({ txn, fmv, fmvSourceDate, withholdingRate, fxRate, overrides = {} }) {
  const grossUnits = overrides.grossUnits != null
    ? Number(overrides.grossUnits)
    : Number(txn.gross_units);
  const resolvedFmv = overrides.fmv != null ? Number(overrides.fmv) : Number(fmv);
  const resolvedRate = overrides.withholdingRate != null
    ? Number(overrides.withholdingRate)
    : Number(withholdingRate);
  const resolvedFx = overrides.fxRate != null ? Number(overrides.fxRate) : Number(fxRate);

  // withheld/net may be explicitly edited; otherwise derived from gross*rate.
  const withheldUnits = overrides.withheldUnits != null
    ? Number(overrides.withheldUnits)
    : round(grossUnits * resolvedRate, 3);
  const netUnits = overrides.netUnits != null
    ? Number(overrides.netUnits)
    : round(grossUnits - withheldUnits, 3);

  const usdAmount = round(netUnits * resolvedFmv, 2);
  const inrAmount = resolvedFx != null && Number.isFinite(resolvedFx)
    ? round(netUnits * resolvedFmv * resolvedFx, 2)
    : null;

  return {
    grossUnits,
    fmv: resolvedFmv,
    fmvSourceDate: fmvSourceDate || null,
    withholdingRate: resolvedRate,
    withheldUnits,
    netUnits,
    fxRate: resolvedFx ?? null,
    usdAmount,
    amount: inrAmount,
    // effective rate implied by the (possibly edited) net/gross split:
    effectiveWithholdingRate: grossUnits > 0 ? round(withheldUnits / grossUnits, 6) : null,
  };
}

/**
 * Derive a full actualization candidate for a placeholder vest, including
 * warnings. FX is supplied by the caller (async fetch happens upstream).
 */
function deriveVestActualization(db, txn, { fxRate = null } = {}) {
  const vestDate = String(txn.transaction_date).slice(0, 10);
  const warnings = [];

  const fmvInfo = getPriorTradingClose(db, txn.investment_id, vestDate);
  if (!fmvInfo) {
    return { derivable: false, reason: 'No cached price before vest date to derive FMV', vestDate };
  }
  if (fmvInfo.lagDays > 5) {
    warnings.push({
      code: 'FMV_SOURCE_LAG',
      message: `FMV source (${fmvInfo.sourceDate}) is ${fmvInfo.lagDays} days before the vest date; verify no closer session exists.`,
    });
  }

  const rateInfo = getCarriedForwardWithholdingRate(db, txn.investment_id, vestDate, Number(txn.gross_units));
  if (!rateInfo) {
    warnings.push({
      code: 'NO_PRIOR_RATE',
      message: 'No prior actualized vest to infer the withholding rate; enter it manually.',
    });
  } else {
    warnings.push({
      code: 'RATE_CARRIED_FORWARD',
      message: `Withholding rate ${(rateInfo.rate * 100).toFixed(3)}% carried forward from the ${rateInfo.basisDate} vest`
        + `${rateInfo.matchedGross ? ` (same gross ${rateInfo.grossUnits})` : ` (gross ${rateInfo.grossUnits}; different size)`}.`
        + ' Reconcile against the broker once vested.',
    });
  }

  // Our cached USD/INR (Yahoo/FBIL reference) has been observed to differ from
  // the rate the broker actually applies (SBI TT buying rate runs ~0.5% higher),
  // so FX is low-confidence: surface it for review rather than trusting silently.
  if (fxRate == null) {
    warnings.push({
      code: 'NO_FX',
      message: 'USD/INR rate for the vest date is unavailable; enter it manually.',
    });
  } else {
    warnings.push({
      code: 'FX_REFERENCE_UNCERTAIN',
      message: 'FX is our cached USD/INR reference rate; the broker may use the SBI TT buying rate. Verify/adjust before accepting.',
    });
  }

  const values = computeVestValues({
    txn,
    fmv: fmvInfo.fmv,
    fmvSourceDate: fmvInfo.sourceDate,
    withholdingRate: rateInfo ? rateInfo.rate : null,
    fxRate,
  });

  return {
    derivable: true,
    vestDate,
    investmentId: Number(txn.investment_id),
    portfolioId: txn.portfolio_id == null ? null : Number(txn.portfolio_id),
    transactionId: Number(txn.id),
    notes: txn.notes || null,
    fmvSource: fmvInfo.source,
    fmvLagDays: fmvInfo.lagDays,
    rateBasisDate: rateInfo ? rateInfo.basisDate : null,
    values,
    warnings,
  };
}

/**
 * Find placeholder VEST rows whose vest date has settled (<= asOfDate - settleDays).
 * A settle buffer (default 2 days) avoids acting on a just-passed vest: the US vest
 * date can shift a day by timezone, and the FMV/FX surrounding sessions need to be
 * cached and stabilized first. Returns the raw transaction rows; FX + derivation
 * happen in the caller.
 */
function findActualizableVestRows(db, { portfolioId = null, asOfDate = null, settleDays = 2 } = {}) {
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const buffer = Number.isFinite(Number(settleDays)) && Number(settleDays) >= 0 ? Math.floor(Number(settleDays)) : 2;
  const cutoffMs = new Date(`${asOf}T00:00:00.000Z`).getTime() - buffer * 86400000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  const params = [];
  let scope = '';
  if (portfolioId != null) {
    scope = 'AND t.portfolio_id = ?';
    params.push(portfolioId);
  }
  params.push(cutoff);

  return db.prepare(`
    SELECT t.id, t.investment_id, t.portfolio_id, t.transaction_date,
           t.gross_units, t.tax_withheld_units, t.units, t.price_per_unit,
           t.fmv_per_unit, t.amount, t.usd_amount, t.exchange_rate_used, t.notes,
           i.currency, i.asset_type, i.name
    FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE t.transaction_type = 'VEST'
      ${scope}
      AND DATE(t.transaction_date) <= ?
      AND (${PLACEHOLDER_VEST_SQL.replace(/\b(gross_units|units|price_per_unit|fmv_per_unit|amount)\b/g, 't.$1')})
    ORDER BY DATE(t.transaction_date) ASC, t.id ASC
  `).all(...params);
}

/**
 * Stable fingerprint for an RSU vest suggestion. Keyed on the concrete
 * transaction (id + vest date), so a placeholder maps to exactly one suggestion
 * across regenerations regardless of how often we scan.
 */
function rsuVestSuggestionFingerprint(derived) {
  return [
    'RSU_VEST',
    derived.investmentId,
    derived.portfolioId == null ? '' : derived.portfolioId,
    'VEST',
    derived.vestDate,
    derived.transactionId,
  ].join('|');
}

/**
 * Scan placeholder VEST rows and upsert pending RSU vest suggestions into
 * corporate_action_suggestions (source = 'RSU_VEST'). Shared by the on-demand
 * route and the auto-backfill CA sub-step.
 *
 * FX is resolved via the injected `resolveFxRate(date) => number|null` so the
 * caller controls the source: the route passes an async network fetch, while
 * the backfill passes a synchronous read of the prewarmed FX cache (no network).
 *
 * Dedup honours prior resolutions: a fingerprint already 'rejected' or 'applied'
 * is suppressed (never re-queued), an existing 'pending' one is refreshed, and a
 * brand-new one is inserted.
 *
 * @returns {Promise<{scanned:number, queued:number, refreshed:number, suppressed:number, skipped:number, previews:Array}>}
 */
async function generateVestSuggestions(db, {
  portfolioId = null,
  asOfDate = null,
  settleDays = 2,
  resolveFxRate = async () => null,
} = {}) {
  const rows = findActualizableVestRows(db, { portfolioId, asOfDate, settleDays });

  const fxByDate = new Map();
  const getFx = async (date) => {
    if (fxByDate.has(date)) return fxByDate.get(date);
    let fx = null;
    try {
      const v = await resolveFxRate(date);
      fx = Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
    } catch (_e) {
      fx = null;
    }
    fxByDate.set(date, fx);
    return fx;
  };

  const findLatestByFingerprint = db.prepare(`
    SELECT id, status FROM corporate_action_suggestions
    WHERE fingerprint = ?
    ORDER BY id DESC LIMIT 1
  `);
  const insertSuggestion = db.prepare(`
    INSERT INTO corporate_action_suggestions (
      source, action, investment_id, portfolio_id, transaction_type,
      transaction_date, fingerprint, payload_json, notes, status, created_at, updated_at
    ) VALUES ('RSU_VEST', 'updated', ?, ?, 'VEST', ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `);
  const refreshSuggestion = db.prepare(`
    UPDATE corporate_action_suggestions
    SET payload_json = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  let queued = 0;
  let refreshed = 0;
  let suppressed = 0;
  let skipped = 0;
  const previews = [];

  for (const txn of rows) {
    const vestDate = String(txn.transaction_date).slice(0, 10);
    const fx = await getFx(vestDate);
    const derived = deriveVestActualization(db, txn, { fxRate: fx });
    if (!derived.derivable) {
      skipped += 1;
      continue;
    }

    const fingerprint = rsuVestSuggestionFingerprint(derived);
    const existing = findLatestByFingerprint.get(fingerprint);

    // Never resurrect a suggestion the user already resolved.
    if (existing && (existing.status === 'rejected' || existing.status === 'applied')) {
      suppressed += 1;
      continue;
    }

    const payload = {
      investmentId: derived.investmentId,
      portfolioId: derived.portfolioId,
      transactionId: derived.transactionId,
      transactionDate: vestDate,
      investmentName: txn.name || null,
      currency: txn.currency || null,
      notes: txn.notes || null,
      base: {
        grossUnits: Number(txn.gross_units),
        fmv: derived.values.fmv,
        fmvSourceDate: derived.values.fmvSourceDate,
        fmvSource: derived.fmvSource,
        fmvLagDays: derived.fmvLagDays,
        withholdingRate: derived.values.withholdingRate,
        rateBasisDate: derived.rateBasisDate,
        fxRate: derived.values.fxRate,
      },
      values: derived.values,
      warnings: derived.warnings,
    };

    const notes = `Actualize ${txn.name || 'RSU'} vest ${vestDate}`;
    if (existing && existing.status === 'pending') {
      refreshSuggestion.run(JSON.stringify(payload), notes, existing.id);
      refreshed += 1;
    } else {
      insertSuggestion.run(
        derived.investmentId,
        derived.portfolioId,
        vestDate,
        fingerprint,
        JSON.stringify(payload),
        notes
      );
      queued += 1;
    }
    previews.push(payload);
  }

  return { scanned: rows.length, queued, refreshed, suppressed, skipped, previews };
}

module.exports = {
  PLACEHOLDER_VEST_SQL,
  getPriorTradingClose,
  getCarriedForwardWithholdingRate,
  computeVestValues,
  deriveVestActualization,
  findActualizableVestRows,
  rsuVestSuggestionFingerprint,
  generateVestSuggestions,
};
