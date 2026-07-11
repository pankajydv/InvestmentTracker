const RGB_PORTFOLIO_COLORS = {
  pankaj: '#ef4444',
  anju: '#22c55e',
  yashita: '#3b82f6',
};

export function resolvePortfolioColor(portfolioLike) {
  const name = String(portfolioLike?.name || portfolioLike?.portfolio_name || '').trim().toLowerCase();
  const existing = String(portfolioLike?.color || portfolioLike?.portfolio_color || '').trim();

  if (name.includes('pankaj')) return RGB_PORTFOLIO_COLORS.pankaj;
  if (name.includes('anju')) return RGB_PORTFOLIO_COLORS.anju;
  if (name.includes('yashita')) return RGB_PORTFOLIO_COLORS.yashita;

  return existing || '#6c757d';
}

export { RGB_PORTFOLIO_COLORS };