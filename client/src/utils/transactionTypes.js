// Single source of truth for the transaction types offered per asset type.
//
// Two flows consume this module:
//   * The global "Add Investment" page opens a brand-new position and has no investment
//     context, so it uses `getCreationTransactionTypes(assetType)`.
//   * The per-investment "Add Transaction" flow already knows which investment it is
//     acting on, so it uses `getInvestmentTransactionTypes(investment)`. That set starts
//     from the creation set, layers on lifecycle types (interest, dividends, ...), and
//     applies context-specific refinements derived from the investment itself (EPS
//     sub-accounts, USD ESPP/RSU grants, ...).
//
// Keeping both lists here means the two flows can no longer drift apart (e.g. bonds
// offering REDEMPTION in one place but not the other).

// Types shown when opening a position in the global "Add Investment" flow.
const CREATION_TXN_TYPES = {
  MUTUAL_FUND: ['BUY', 'SELL'],
  INDIAN_STOCK: ['BUY', 'SELL'],
  FOREIGN_STOCK: ['BUY', 'SELL'],
  BOND: ['BUY', 'SELL', 'REDEMPTION'],
  SGB: ['BUY', 'SELL', 'REDEMPTION'],
  PPF: ['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'RECONCILE'],
  SSY: ['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'RECONCILE'],
  PF: ['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'INTEREST', 'WITHDRAWAL', 'RECONCILE'],
  NPS: ['EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'TRANSFER_IN', 'TRANSFER_OUT', 'AMC', 'CHARGES'],
};

// Lifecycle types layered on top of the creation set once the investment exists.
const LIFECYCLE_TXN_TYPES = {
  MUTUAL_FUND: ['DIVIDEND'],
  INDIAN_STOCK: ['DIVIDEND'],
  FOREIGN_STOCK: ['DIVIDEND'],
  BOND: ['INTEREST'],
  SGB: ['INTEREST'],
};

const DEFAULT_CREATION_TXN_TYPES = ['BUY', 'SELL'];
const DEFAULT_INVESTMENT_TXN_TYPES = ['BUY', 'SELL', 'DIVIDEND'];

function normalizeAssetType(assetType) {
  return String(assetType || '').toUpperCase();
}

function dedupe(list) {
  return [...new Set(list)];
}

// Transaction types for the global "Add Investment" (position-opening) flow.
export function getCreationTransactionTypes(assetType) {
  const key = normalizeAssetType(assetType);
  return CREATION_TXN_TYPES[key] || DEFAULT_CREATION_TXN_TYPES;
}

// Transaction types for the per-investment "Add Transaction" flow. Builds on the
// creation set and applies context-specific refinements from the investment itself.
export function getInvestmentTransactionTypes(investment) {
  if (!investment) return [...DEFAULT_INVESTMENT_TXN_TYPES];

  const assetType = normalizeAssetType(investment.asset_type);
  const currency = normalizeAssetType(investment.currency);
  const name = String(investment.name || '');

  // Context-specific refinements that cannot be derived from the creation set alone.
  if (assetType === 'PF' && /eps/i.test(name)) {
    return ['EPS_CONTRIBUTION', 'INTEREST', 'WITHDRAWAL', 'RECONCILE'];
  }
  if (assetType === 'FOREIGN_STOCK' && currency === 'USD') {
    return ['VEST', 'ESPP_CONTRIBUTION', 'ESPP_PURCHASE', 'BUY', 'SELL', 'DIVIDEND'];
  }

  if (!CREATION_TXN_TYPES[assetType]) return [...DEFAULT_INVESTMENT_TXN_TYPES];

  return dedupe([...CREATION_TXN_TYPES[assetType], ...(LIFECYCLE_TXN_TYPES[assetType] || [])]);
}
