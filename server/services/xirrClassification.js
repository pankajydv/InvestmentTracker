const { PROVIDENT_ASSET_TYPES, normalizeTransactionType } = require('./transactionEffectPolicy');
const { XIRR_CASH_OUTFLOW_TYPES, XIRR_CASH_INFLOW_TYPES } = require('../constants/transactionTypes');

// Single source for XIRR cash-flow direction. Outflow = money invested (negative),
// inflow = money received (positive). Types in neither set carry no external cash.
const XIRR_OUTFLOW_TYPES = new Set(XIRR_CASH_OUTFLOW_TYPES);
const XIRR_INFLOW_TYPES = new Set(XIRR_CASH_INFLOW_TYPES);

// For balance-based provident accounts (PF/PPF/SSY), interest, TDS, and reconcile
// entries are internal balance movements, not external cash flows for XIRR.
function isInternalXirrCashflow(assetType, transactionType) {
  if (!PROVIDENT_ASSET_TYPES.has(String(assetType || '').toUpperCase())) return false;
  const type = normalizeTransactionType(transactionType);
  return type === 'INTEREST' || type === 'TDS' || type === 'RECONCILE';
}

// Auto-accrued provident interest flagged internal-only in notes is not an external flow.
function isAccrualOnlyXirrCashflow(transactionType, notes) {
  if (normalizeTransactionType(transactionType) !== 'INTEREST') return false;
  const noteText = String(notes || '').toUpperCase();
  return noteText.includes('AUTO_ACCRUAL_INTERNAL') || noteText.includes('ACCRUAL_ONLY_INTERNAL');
}

module.exports = {
  XIRR_OUTFLOW_TYPES,
  XIRR_INFLOW_TYPES,
  isInternalXirrCashflow,
  isAccrualOnlyXirrCashflow,
};
