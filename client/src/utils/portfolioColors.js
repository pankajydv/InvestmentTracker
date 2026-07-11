const RGB_PORTFOLIO_COLORS = {
  pankaj: '#ef4444',
  anju: '#22c55e',
  yashita: '#3b82f6',
};

const OWNER_FULL_NAMES = {
  pankaj: 'Pankaj Yadav',
  anju: 'Anju Yadav',
  yashita: 'Yashita Yadav',
};

function normalizeHexColor(color) {
  return String(color || '').trim().toLowerCase();
}

export function resolvePortfolioColor(portfolioLike) {
  const name = String(portfolioLike?.name || portfolioLike?.portfolio_name || '').trim().toLowerCase();
  const existing = String(portfolioLike?.color || portfolioLike?.portfolio_color || '').trim();

  if (name.includes('pankaj')) return RGB_PORTFOLIO_COLORS.pankaj;
  if (name.includes('anju')) return RGB_PORTFOLIO_COLORS.anju;
  if (name.includes('yashita')) return RGB_PORTFOLIO_COLORS.yashita;

  return existing || '#6c757d';
}

export function resolvePortfolioOwnerLabel(portfolioLike) {
  const name = String(portfolioLike?.name || portfolioLike?.portfolio_name || '').trim().toLowerCase();

  if (name.includes('pankaj')) return OWNER_FULL_NAMES.pankaj;
  if (name.includes('anju')) return OWNER_FULL_NAMES.anju;
  if (name.includes('yashita')) return OWNER_FULL_NAMES.yashita;

  const color = normalizeHexColor(resolvePortfolioColor(portfolioLike));
  if (color === normalizeHexColor(RGB_PORTFOLIO_COLORS.pankaj)) return OWNER_FULL_NAMES.pankaj;
  if (color === normalizeHexColor(RGB_PORTFOLIO_COLORS.anju)) return OWNER_FULL_NAMES.anju;
  if (color === normalizeHexColor(RGB_PORTFOLIO_COLORS.yashita)) return OWNER_FULL_NAMES.yashita;

  return '';
}

export { RGB_PORTFOLIO_COLORS };