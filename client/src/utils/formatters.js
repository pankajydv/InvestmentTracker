/**
 * Format number as Indian currency (₹)
 */
export function formatINR(amount, decimals = 0) {
  if (amount == null || isNaN(amount)) return '₹0';

  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  // Use Indian numbering system (Lakh, Crore)
  if (abs >= 10000000) {
    return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  }
  if (abs >= 100000) {
    return `${sign}₹${(abs / 100000).toFixed(2)} Lakh`;
  }

  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
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
export function formatPct(pct, decimals = 1) {
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
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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
  MUTUAL_FUND: 'Mutual Funds',
  INDIAN_STOCK: 'Indian Stocks',
  FOREIGN_STOCK: 'Foreign Stocks',
  PPF: 'PPF',
  PF: 'PF',
};

/**
 * Asset type colors for charts
 */
export const ASSET_TYPE_COLORS = {
  MUTUAL_FUND: '#3b82f6',
  INDIAN_STOCK: '#10b981',
  FOREIGN_STOCK: '#8b5cf6',
  PPF: '#f59e0b',
  PF: '#ef4444',
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
