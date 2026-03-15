const API_BASE = '/api';

async function fetchJSON(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Dashboard
export const getDashboardSummary = (portfolioId, { hideSold } = {}) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  if (hideSold) params.set('hide_sold', 'true');
  return fetchJSON(`/dashboard/summary?${params}`);
};
export const getPerformance = (period, from, to, portfolioId) => {
  const params = new URLSearchParams();
  if (period) params.set('period', period);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (portfolioId) params.set('portfolio_id', portfolioId);
  return fetchJSON(`/dashboard/performance?${params}`);
};
export const getInvestmentPerformance = (id, period) =>
  fetchJSON(`/dashboard/performance/${id}?period=${period}`);
export const getAllocation = (portfolioId) => {
  const params = portfolioId ? `?portfolio_id=${portfolioId}` : '';
  return fetchJSON(`/dashboard/allocation${params}`);
};

// Portfolios
export const getPortfolios = () => fetchJSON('/portfolios');
export const createPortfolio = (data) =>
  fetchJSON('/portfolios', { method: 'POST', body: JSON.stringify(data) });
export const updatePortfolio = (id, data) =>
  fetchJSON(`/portfolios/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deletePortfolio = (id) =>
  fetchJSON(`/portfolios/${id}`, { method: 'DELETE' });

// Investments
export const getInvestments = (type, portfolioId, { hideSold } = {}) => {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (portfolioId) params.set('portfolio_id', portfolioId);
  if (hideSold) params.set('hide_sold', 'true');
  return fetchJSON(`/investments?${params}`);
};
export const getInvestment = (id) => fetchJSON(`/investments/${id}`);
export const createInvestment = (data) =>
  fetchJSON('/investments', { method: 'POST', body: JSON.stringify(data) });
export const updateInvestment = (id, data) =>
  fetchJSON(`/investments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteInvestment = (id) =>
  fetchJSON(`/investments/${id}`, { method: 'DELETE' });

// Transactions
export const getTransactions = (params = {}) => {
  const qs = new URLSearchParams(params);
  return fetchJSON(`/transactions?${qs}`);
};
export const getBrokers = () => fetchJSON('/transactions/brokers');
export const getInvestmentNames = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return fetchJSON(`/transactions/investment-names${query ? '?' + query : ''}`);
};
export const addTransaction = (data) =>
  fetchJSON('/transactions', { method: 'POST', body: JSON.stringify(data) });
export const updateTransaction = (id, data) =>
  fetchJSON(`/transactions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteTransaction = (id) =>
  fetchJSON(`/transactions/${id}`, { method: 'DELETE' });

// Utils
export const searchMutualFunds = (q) => fetchJSON(`/utils/search-mf?q=${encodeURIComponent(q)}`);
export const searchStock = (symbol, market) =>
  fetchJSON(`/utils/search-stock?symbol=${encodeURIComponent(symbol)}&market=${market || ''}`);
export const triggerPriceUpdate = () =>
  fetchJSON('/utils/update-prices', { method: 'POST' });
export const getConfig = () => fetchJSON('/utils/config');
export const updateConfig = (data) =>
  fetchJSON('/utils/config', { method: 'PUT', body: JSON.stringify(data) });
export const getInterestRates = () => fetchJSON('/utils/interest-rates');

// CAS Upload
export const uploadCASPreview = async (file, portfolioId) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('portfolio_id', portfolioId);
  const res = await fetch(`${API_BASE}/cas/preview`, { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};
export const importCASHoldings = (portfolioId, holdings) =>
  fetchJSON('/cas/import', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, holdings }) });

// Contract Notes - Preview (parse and validate, no import)
export const previewContractNotes = async (files, portfolioId) => {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  formData.append('portfolio_id', portfolioId);
  const res = await fetch(`${API_BASE}/stocks/contract-notes/preview`, { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};

// Contract Notes - Import approved trades
export const importContractNotes = async (portfolioId, broker, trades) => {
  return fetchJSON('/stocks/contract-notes/import', {
    method: 'POST',
    body: JSON.stringify({ portfolio_id: portfolioId, broker, trades }),
  });
};

// P&L Statement Upload
export const uploadPnLStatement = async (file, broker, portfolioId) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('broker', broker);
  formData.append('portfolio_id', portfolioId);
  const res = await fetch(`${API_BASE}/stocks/pnl`, { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};

// AMC / Maintenance Charges
export const addAmcCharge = (data) =>
  fetchJSON('/stocks/amc-charge', { method: 'POST', body: JSON.stringify(data) });
