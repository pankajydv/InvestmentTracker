const API_BASE = '/api';

async function fetchJSON(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Auth
export const getAuthConfig = () => fetchJSON('/auth/config');
export const loginWithGoogle = (credential) =>
  fetchJSON('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) });
export const getCurrentUser = () => fetchJSON('/auth/me');
export const logout = () => fetchJSON('/auth/logout', { method: 'POST' });

// Dashboard
export const getDashboardSummary = (portfolioId, { hideSold, includeFullySoldInReturns, xirrMode, interval, customFromDate, customToDate } = {}) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  if (hideSold) params.set('hide_sold', 'true');
  if (includeFullySoldInReturns) params.set('include_sold_in_returns', 'true');
  if (xirrMode) params.set('xirr_mode', String(xirrMode));
  if (interval) params.set('interval', String(interval));
  if (customFromDate) params.set('custom_from_date', String(customFromDate));
  if (customToDate) params.set('custom_to_date', String(customToDate));
  return fetchJSON(`/dashboard/summary?${params}`);
};
// Batch endpoint: fetch summary, health, and allocation in single request (optimized)
export const getDashboardBatch = (portfolioId, { requests = 'summary,health,allocation', hideSold, includeFullySoldInReturns, xirrMode, interval, customFromDate, customToDate, runDate } = {}) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  params.set('requests', requests);
  if (hideSold) params.set('hide_sold', 'true');
  if (includeFullySoldInReturns) params.set('include_sold_in_returns', 'true');
  if (xirrMode) params.set('xirr_mode', String(xirrMode));
  if (interval) params.set('interval', String(interval));
  if (customFromDate) params.set('custom_from_date', String(customFromDate));
  if (customToDate) params.set('custom_to_date', String(customToDate));
  if (runDate) params.set('run_date', runDate);
  return fetchJSON(`/dashboard/batch?${params}`);
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
export const getInvestment = (id, portfolioId, { interval, customFromDate, customToDate } = {}) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  if (interval) params.set('interval', String(interval));
  if (customFromDate) params.set('custom_from_date', String(customFromDate));
  if (customToDate) params.set('custom_to_date', String(customToDate));
  const qs = params.toString();
  return fetchJSON(`/investments/${id}${qs ? `?${qs}` : ''}`);
};
export const createInvestment = (data) =>
  fetchJSON('/investments', { method: 'POST', body: JSON.stringify(data) });
export const updateInvestment = (id, data) =>
  fetchJSON(`/investments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteInvestment = (id) =>
  fetchJSON(`/investments/${id}`, { method: 'DELETE' });
export const getInvestmentHistoricalPrices = (id, {
  from,
  to,
  limit,
  page,
  pageSize,
} = {}) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', String(limit));
  if (page) params.set('page', String(page));
  if (pageSize) params.set('page_size', String(pageSize));
  const qs = params.toString();
  return fetchJSON(`/investments/${id}/historical-prices${qs ? `?${qs}` : ''}`);
};
export const getInvestmentDailyValues = (id, {
  from,
  to,
  limit,
  page,
  pageSize,
  portfolioId,
} = {}) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', String(limit));
  if (page) params.set('page', String(page));
  if (pageSize) params.set('page_size', String(pageSize));
  if (portfolioId) params.set('portfolio_id', String(portfolioId));
  const qs = params.toString();
  return fetchJSON(`/investments/${id}/daily-values${qs ? `?${qs}` : ''}`);
};
export const getInvestmentFxRateCache = (id, {
  from,
  to,
  limit,
  page,
  pageSize,
} = {}) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', String(limit));
  if (page) params.set('page', String(page));
  if (pageSize) params.set('page_size', String(pageSize));
  const qs = params.toString();
  return fetchJSON(`/investments/${id}/fx-rate-cache${qs ? `?${qs}` : ''}`);
};
export const getInvestmentSymbolHistory = (id) =>
  fetchJSON(`/investments/${id}/symbol-history`);
export const createInvestmentSymbolHistory = (id, data) =>
  fetchJSON(`/investments/${id}/symbol-history`, { method: 'POST', body: JSON.stringify(data) });
export const updateInvestmentSymbolHistory = (id, historyId, data) =>
  fetchJSON(`/investments/${id}/symbol-history/${historyId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteInvestmentSymbolHistory = (id, historyId) =>
  fetchJSON(`/investments/${id}/symbol-history/${historyId}`, { method: 'DELETE' });

// Transactions
export const getTransactions = (params = {}) => {
  const qs = new URLSearchParams(params);
  return fetchJSON(`/transactions?${qs}`);
};
export const getBrokers = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return fetchJSON(`/transactions/brokers${qs ? '?' + qs : ''}`);
};
export const getAssetTypes = () => fetchJSON('/transactions/asset-types');
export const getTransactionTypes = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return fetchJSON(`/transactions/transaction-types${qs ? '?' + qs : ''}`);
};
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
export const getUSDINRRate = (date) =>
  fetchJSON(`/transactions/usd-inr-rate${date ? `?date=${encodeURIComponent(date)}` : ''}`);

// Tax Reports
export const getTaxReport = (fy, portfolioId) => {
  const params = new URLSearchParams({ fy });
  if (portfolioId) params.set('portfolio_id', portfolioId);
  return fetchJSON(`/tax/us-stocks?${params.toString()}`);
};

// Utils
export const searchMutualFunds = (q) => fetchJSON(`/utils/search-mf?q=${encodeURIComponent(q)}`);
export const searchStockByName = (q, market) =>
  fetchJSON(`/utils/search-stock-name?q=${encodeURIComponent(q)}&market=${market || ''}`);
export const searchStock = (symbol, market) =>
  fetchJSON(`/utils/search-stock?symbol=${encodeURIComponent(symbol)}&market=${market || ''}`);
export const triggerPriceUpdate = (options) => {
  const payload = {};

  if (Array.isArray(options)) {
    payload.assetTypes = options;
  } else if (options && typeof options === 'object') {
    if (Array.isArray(options.assetTypes)) payload.assetTypes = options.assetTypes;
  }

  return fetchJSON('/utils/update-prices', {
    method: 'POST',
    body: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined,
  });
};
export const cancelPriceUpdate = () =>
  fetchJSON('/utils/cancel-update', { method: 'POST' });
export const getLogFiles = () => fetchJSON('/utils/log-files');
export const downloadLogFile = async (name) => {
  const safeName = encodeURIComponent(String(name || '').trim());
  const res = await fetch(`${API_BASE}/utils/log-files/${safeName}`, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Log download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/);
  a.download = match ? match[1] : String(name || 'app.log');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
export const getConfig = () => fetchJSON('/utils/config');
export const updateConfig = (data) =>
  fetchJSON('/utils/config', { method: 'PUT', body: JSON.stringify(data) });
export const getDailyValuesHealthStatus = (portfolioId, runDate) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', String(portfolioId));
  if (runDate) params.set('run_date', runDate);
  return fetchJSON(`/utils/daily-values-health${params.toString() ? `?${params.toString()}` : ''}`);
};
export const getComplianceStatus = (runDate) => {
  const params = new URLSearchParams();
  if (runDate) params.set('run_date', runDate);
  return fetchJSON(`/utils/compliance-status${params.toString() ? `?${params.toString()}` : ''}`);
};
export const createComplianceJob = ({ mode = 'incremental', runDate } = {}) => {
  const payload = { mode };
  if (runDate) payload.run_date = runDate;
  return fetchJSON('/utils/compliance-jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
};
export const getComplianceJobs = ({ active = false, limit } = {}) => {
  const params = new URLSearchParams();
  if (active) params.set('active', 'true');
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) params.set('limit', String(Math.floor(Number(limit))));
  return fetchJSON(`/utils/compliance-jobs${params.toString() ? `?${params.toString()}` : ''}`);
};
export const getComplianceJob = (jobId) =>
  fetchJSON(`/utils/compliance-jobs/${encodeURIComponent(String(jobId || '').trim())}`);
export const markDirtyScopesFromSelector = (payload) =>
  fetchJSON('/utils/dirty-backfill-scopes/mark', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
export const purgeMarketPriceCache = (payload) =>
  fetchJSON('/utils/market-price-cache/purge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
export const getInterestRates = () => fetchJSON('/utils/interest-rates');
export const createInterestRate = (data) =>
  fetchJSON('/utils/interest-rates', { method: 'POST', body: JSON.stringify(data) });
export const updateInterestRate = (id, data) =>
  fetchJSON(`/utils/interest-rates/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteInterestRate = (id) =>
  fetchJSON(`/utils/interest-rates/${id}`, { method: 'DELETE' });

// CAS Upload
export const uploadCASPreview = async (file, portfolioId, password) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('portfolio_id', portfolioId);
  if (password) formData.append('password', password);
  const res = await fetch(`${API_BASE}/cas/preview`, { method: 'POST', body: formData, credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};
export const importCASHoldings = (portfolioId, holdings) =>
  fetchJSON('/cas/import', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, holdings }) });

export const importCAMSCASTransactions = (portfolioId, schemes) =>
  fetchJSON('/cas/cams-import', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, schemes }) });

// Contract Notes - Preview (parse and validate, no import)
export const previewContractNotes = async (files, portfolioId) => {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  formData.append('portfolio_id', portfolioId);
  const res = await fetch(`${API_BASE}/stocks/contract-notes/preview`, { method: 'POST', body: formData, credentials: 'include' });
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

// RSU Grants (annual, on-hire, special)
export const previewRsuGrantSchedule = (params = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  return fetchJSON(`/stocks/rsu-grants/preview${qs.toString() ? `?${qs}` : ''}`);
};

export const importRsuGrantSchedule = (data = {}) =>
  fetchJSON('/stocks/rsu-grants/import', {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ESPP Grants (offering-based purchase placeholders)
export const previewEsppGrantSchedule = (params = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  return fetchJSON(`/stocks/espp-grants/preview${qs.toString() ? `?${qs}` : ''}`);
};

export const importEsppGrantSchedule = (data = {}) =>
  fetchJSON('/stocks/espp-grants/import', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const previewEsppContributionsFromPayslips = async (files, investmentId, portfolioId) => {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));
  formData.append('investment_id', String(investmentId));
  formData.append('portfolio_id', String(portfolioId));
  const res = await fetch(`${API_BASE}/stocks/espp-contributions/preview`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'ESPP contribution preview failed');
  }
  return res.json();
};

export const importEsppContributions = (data = {}) =>
  fetchJSON('/stocks/espp-contributions/import', {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ESPP share acquisitions (quarterly purchase history), prepared from OCR/UI extraction rows.
export const previewEsppAcquisitions = (data = {}) =>
  fetchJSON('/stocks/espp-acquisitions/preview', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const importEsppAcquisitions = (data = {}) =>
  fetchJSON('/stocks/espp-acquisitions/import', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const previewRsuGrantDocuments = async (files) => {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));
  const res = await fetch(`${API_BASE}/stocks/rsu-grants/documents/preview`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'RSU document preview failed');
  }
  return res.json();
};

export const reconcileRsuWithFidelityLots = async ({ investment_id, portfolio_id, openLotsFile, closedLotsFile, dry_run = true, overwrite_price = true }) => {
  const formData = new FormData();
  if (investment_id) formData.append('investment_id', String(investment_id));
  if (portfolio_id) formData.append('portfolio_id', String(portfolio_id));
  formData.append('dry_run', String(Boolean(dry_run)));
  formData.append('overwrite_price', String(Boolean(overwrite_price)));
  if (openLotsFile) formData.append('open_lots', openLotsFile);
  if (closedLotsFile) formData.append('closed_lots', closedLotsFile);

  const res = await fetch(`${API_BASE}/stocks/rsu-grants/reconcile-fidelity`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'RSU fidelity reconciliation failed');
  }
  return res.json();
};

// P&L Statement Upload
export const uploadPnLStatement = async (file, broker, portfolioId) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('broker', broker);
  formData.append('portfolio_id', portfolioId);
  const res = await fetch(`${API_BASE}/stocks/pnl`, { method: 'POST', body: formData, credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};

// AMC / Maintenance Charges (now stored as portfolio expenses)
export const addAmcCharge = (data) =>
  fetchJSON('/expenses', { method: 'POST', body: JSON.stringify(data) });

// NPS Statement Upload
export const previewNPSStatements = async (files, portfolioId, password, payslipFiles = []) => {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  (payslipFiles || []).forEach(f => formData.append('payslips', f));
  formData.append('portfolio_id', portfolioId);
  if (password) formData.append('password', password);
  const res = await fetch(`${API_BASE}/nps/preview`, { method: 'POST', body: formData, credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};

export const importNPSTransactions = (portfolioId, pran, schemes) =>
  fetchJSON('/nps/import', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, pran, schemes }) });

// PPF/SSY Statement Upload
export const previewPPFStatements = async (files, portfolioId, password) => {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  formData.append('portfolio_id', portfolioId);
  if (password) formData.append('password', password);
  const res = await fetch(`${API_BASE}/ppf/preview`, { method: 'POST', body: formData, credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};

export const importPPFTransactions = (portfolioId, data) =>
  fetchJSON('/ppf/import', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, ...data }) });

// PF Statement Upload
export const previewPFStatements = async (files, portfolioId) => {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  formData.append('portfolio_id', portfolioId);
  const res = await fetch(`${API_BASE}/pf/preview`, { method: 'POST', body: formData, credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
};

export const importPFTransactions = (portfolioId, data) =>
  fetchJSON('/pf/import', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, ...data }) });

export const addManualPFTransaction = (portfolioId, data) =>
  fetchJSON('/pf/manual', { method: 'POST', body: JSON.stringify({ portfolio_id: portfolioId, ...data }) });

// Portfolio Expenses
export const getExpenses = (params = {}) => {
  const qs = new URLSearchParams(params);
  return fetchJSON(`/expenses?${qs}`);
};
export const getExpensesSummary = (portfolioId) => {
  const params = portfolioId ? `?portfolio_id=${portfolioId}` : '';
  return fetchJSON(`/expenses/summary${params}`);
};
export const deleteExpense = (id) =>
  fetchJSON(`/expenses/${id}`, { method: 'DELETE' });

// Corporate Actions
export const previewCorporateActions = (portfolioId, assetType) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  if (assetType) params.set('asset_type', assetType);
  return fetchJSON(`/stocks/corporate-actions/preview?${params}`);
};
export const importCorporateActions = ({ transactions, corrections, deletions }) =>
  fetchJSON('/stocks/corporate-actions/import', { method: 'POST', body: JSON.stringify({ transactions, corrections, deletions }) });
export const getCorporateActionSuggestionCount = (portfolioId) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  return fetchJSON(`/stocks/corporate-actions/suggestions/count${params.toString() ? `?${params}` : ''}`);
};
export const getCorporateActionSuggestions = ({ status = 'pending', portfolioId, limit } = {}) => {
  const params = new URLSearchParams();
  if (status) params.set('status', String(status));
  if (portfolioId) params.set('portfolio_id', String(portfolioId));
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) params.set('limit', String(Math.floor(Number(limit))));
  return fetchJSON(`/stocks/corporate-actions/suggestions${params.toString() ? `?${params}` : ''}`);
};
export const resolveCorporateActionSuggestions = ({ ids, decision }) =>
  fetchJSON('/stocks/corporate-actions/suggestions/resolve', {
    method: 'POST',
    body: JSON.stringify({ ids, decision }),
  });
export const resetCorporateActionSuggestions = ({ portfolioId } = {}) =>
  fetchJSON('/stocks/corporate-actions/suggestions/reset', {
    method: 'POST',
    body: JSON.stringify({ portfolio_id: portfolioId || null }),
  });

// ─── RSU Vest Actualization ──────────────────────────────────────────────
export const generateRsuVestSuggestions = ({ portfolioId, asOfDate } = {}) =>
  fetchJSON('/stocks/rsu-vests/generate', {
    method: 'POST',
    body: JSON.stringify({
      portfolio_id: portfolioId || null,
      as_of_date: asOfDate || null,
    }),
  });
export const getRsuVestSuggestionCount = (portfolioId) => {
  const params = new URLSearchParams();
  if (portfolioId) params.set('portfolio_id', portfolioId);
  return fetchJSON(`/stocks/rsu-vests/suggestions/count${params.toString() ? `?${params}` : ''}`);
};
export const getRsuVestSuggestions = ({ status = 'pending', portfolioId, limit } = {}) => {
  const params = new URLSearchParams();
  if (status) params.set('status', String(status));
  if (portfolioId) params.set('portfolio_id', String(portfolioId));
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) params.set('limit', String(Math.floor(Number(limit))));
  return fetchJSON(`/stocks/rsu-vests/suggestions${params.toString() ? `?${params}` : ''}`);
};
export const resolveRsuVestSuggestions = ({ items, decision }) =>
  fetchJSON('/stocks/rsu-vests/suggestions/resolve', {
    method: 'POST',
    body: JSON.stringify({ items, decision }),
  });
export const deriveRsuVestValues = ({ investmentId, date, grossUnits } = {}) => {
  const params = new URLSearchParams();
  params.set('investment_id', String(investmentId));
  params.set('date', String(date));
  if (grossUnits != null && grossUnits !== '') params.set('gross_units', String(grossUnits));
  return fetchJSON(`/stocks/rsu-vests/derive?${params}`);
};

// Interest Rate Sync
export const previewInterestRateSync = (assetType, portfolioId) => {
  const params = new URLSearchParams({ asset_type: assetType });
  if (portfolioId) params.set('portfolio_id', portfolioId);
  return fetchJSON(`/investments/interest-rate-sync/preview?${params}`);
};
export const importInterestRateSync = (data) =>
  fetchJSON('/investments/interest-rate-sync/import', { method: 'POST', body: JSON.stringify(data) });

// Interest Update (PF/PPF/SSY)
export const previewInvestmentInterestUpdate = (investmentId, params = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  return fetchJSON(`/investments/${investmentId}/interest/preview${qs.toString() ? `?${qs}` : ''}`);
};

export const applyInvestmentInterestUpdate = (investmentId, data = {}) =>
  fetchJSON(`/investments/${investmentId}/interest/apply`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

// Export all data as XLSX download
export const exportData = async () => {
  const res = await fetch(`${API_BASE}/utils/export`, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Export failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/);
  a.download = match ? match[1] : `InvestmentTracker_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// Compatibility default export for modules that still use axios-style api.get/api.post.
const api = {
  get: async (url, options = {}) => ({
    data: await fetchJSON(url, { method: 'GET', ...options }),
  }),
  post: async (url, body, options = {}) => ({
    data: await fetchJSON(url, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),
  }),
  put: async (url, body, options = {}) => ({
    data: await fetchJSON(url, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),
  }),
  delete: async (url, options = {}) => ({
    data: await fetchJSON(url, { method: 'DELETE', ...options }),
  }),
};

export default api;
