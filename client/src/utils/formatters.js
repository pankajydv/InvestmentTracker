/**
 * Format number as Indian currency (₹)
 */
export function isPrivacyMaskEnabled() {
  if (typeof document !== 'undefined' && document.body) {
    if (document.body.dataset.privacyMasked === '1') return true;
    if (document.body.dataset.privacyMasked === '0') return false;
  }
  // Always default to masked mode for safety on fresh page load.
  return true;
}

export function getMaskedValue({ currencySymbol = '' } = {}) {
  return currencySymbol ? `${currencySymbol}****` : '****';
}

export function formatINR(amount, decimals = 0, options = {}) {
  const sensitive = options?.sensitive !== false;
  if (sensitive && isPrivacyMaskEnabled()) return getMaskedValue({ currencySymbol: '₹' });
  if (amount == null || isNaN(amount)) return '₹0';

  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  // Use Indian numbering system (L for Lakh, Cr for Crore)
  if (abs >= 10000000) {
    return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  }
  if (abs >= 100000) {
    return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  }

  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatINRExact(amount, decimals = 0, options = {}) {
  const sensitive = options?.sensitive !== false;
  if (sensitive && isPrivacyMaskEnabled()) return getMaskedValue({ currencySymbol: '₹' });
  if (amount == null || isNaN(amount)) return '₹0';

  const value = Number(amount);
  const sign = value < 0 ? '-' : '';
  return `${sign}₹${Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Format number with Indian comma separations
 */
export function formatNumber(num, decimals = 0) {
  if (num == null || isNaN(num)) return '0';
  return Number(num).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format percentage
 */
export function formatPct(pct, decimals = 2) {
  if (pct == null || isNaN(pct)) return '0%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Number(pct).toFixed(decimals)}%`;
}

/**
 * Format date string
 */
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Get color class based on value (positive = green, negative = red)
 */
export function profitColor(value) {
  if (value > 0) return 'text-green-600';
  if (value < 0) return 'text-red-600';
  return 'text-gray-600';
}

/**
 * Get background color class
 */
export function profitBg(value) {
  if (value > 0) return 'bg-green-50';
  if (value < 0) return 'bg-red-50';
  return 'bg-gray-50';
}

/**
 * Asset type display names
 */
export const ASSET_TYPE_LABELS = {
  MUTUAL_FUND: 'MF',
  INDIAN_STOCK: 'Stocks',
  FOREIGN_STOCK: 'FS',
  PPF: 'PPF',
  SSY: 'SSY',
  PF: 'PF',
  BOND: 'Bonds',
  NPS: 'NPS',
  SGB: 'SGB',
};

/**
 * Asset type full names for tooltips
 */
export const ASSET_TYPE_FULL_NAMES = {
  MUTUAL_FUND: 'Mutual Funds',
  INDIAN_STOCK: 'Indian Stocks',
  FOREIGN_STOCK: 'Foreign Stocks',
  PPF: 'Public Provident Funds',
  SSY: 'Sukanya Samriddhi Yojana',
  PF: 'Provident Fund',
  BOND: 'Bonds',
  NPS: 'National Pension Scheme',
  SGB: 'Sovereign Gold Bonds',
};

/**
 * URL slug for each asset type (lowercase short label), e.g. MUTUAL_FUND → 'mf'
 */
export const ASSET_TYPE_SLUG = Object.fromEntries(
  Object.entries(ASSET_TYPE_LABELS).map(([key, label]) => [key, label.toLowerCase()])
);

/**
 * Reverse map from URL slug to asset type key, e.g. 'mf' → 'MUTUAL_FUND'
 */
export const ASSET_TYPE_SLUG_TO_KEY = Object.fromEntries(
  Object.entries(ASSET_TYPE_LABELS).map(([key, label]) => [label.toLowerCase(), key])
);

export const ASSET_TYPE_FILTER_ORDER = [
  'INDIAN_STOCK',
  'MUTUAL_FUND',
  'NPS',
  'SGB',
  'BOND',
  'PF',
  'PPF',
  'SSY',
  'FOREIGN_STOCK',
];

export const ASSET_TYPE_DISPLAY_ORDER = Object.fromEntries(
  ASSET_TYPE_FILTER_ORDER.map((assetType, index) => [assetType, index + 1])
);

export function compareAssetTypes(typeA, typeB) {
  const orderA = ASSET_TYPE_DISPLAY_ORDER[typeA] ?? 999;
  const orderB = ASSET_TYPE_DISPLAY_ORDER[typeB] ?? 999;
  if (orderA !== orderB) return orderA - orderB;
  return String(typeA).localeCompare(String(typeB));
}

/**
 * Asset type colors for charts
 */
export const ASSET_TYPE_COLORS = {
  MUTUAL_FUND: '#3b82f6',
  INDIAN_STOCK: '#10b981',
  FOREIGN_STOCK: '#8b5cf6',
  PPF: '#f59e0b',
  SSY: '#ec4899',
  PF: '#ef4444',
  BOND: '#f97316',
  NPS: '#06b6d4',
  SGB: '#fbbf24',
};

/**
 * Time periods for comparison
 */
export const TIME_PERIODS = [
  { key: '1D', label: '1 Day' },
  { key: '7D', label: '7 Days' },
  { key: '1M', label: '1 Month' },
  { key: '3M', label: '3 Months' },
  { key: '6M', label: '6 Months' },
  { key: '1Y', label: '1 Year' },
  { key: '2Y', label: '2 Years' },
  { key: '3Y', label: '3 Years' },
  { key: '5Y', label: '5 Years' },
];
