import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

const PortfolioContext = createContext();

const STORAGE_KEY = 'selectedPortfolioIds';
const LEGACY_STORAGE_KEY = 'selectedPortfolioId';

function parseStoredSelection(raw) {
  if (!raw || raw === 'all') return { mode: 'all', ids: [] };
  if (raw === 'none') return { mode: 'none', ids: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const ids = parsed
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0);
      if (!ids.length) return { mode: 'none', ids: [] };
      return { mode: 'some', ids };
    }
  } catch (_) {
    const legacyId = Number(raw);
    if (Number.isInteger(legacyId) && legacyId > 0) return { mode: 'some', ids: [legacyId] };
  }
  return { mode: 'all', ids: [] };
}

export function PortfolioProvider({ children }) {
  const [portfolios, setPortfolios] = useState([]);
  const initialSelection = useMemo(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored != null) return parseStoredSelection(stored);

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return parseStoredSelection(legacy);
  }, []);
  const [selectionMode, setSelectionMode] = useState(initialSelection.mode);
  const [explicitSelectedIds, setExplicitSelectedIds] = useState(initialSelection.ids);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPortfolios();
  }, []);

  const loadPortfolios = async () => {
    try {
      const res = await fetch('/api/portfolios');
      if (!res.ok) {
        throw new Error(`Failed to load portfolios (${res.status})`);
      }
      const data = await res.json();
      setPortfolios(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to load portfolios:', e);
      setPortfolios([]);
    } finally {
      setLoading(false);
    }
  };

  const selectedIds = useMemo(() => {
    const validPortfolioIds = new Set(portfolios.map((p) => p.id));
    if (selectionMode === 'all') return portfolios.map((p) => p.id);
    if (selectionMode === 'none') return [];
    return explicitSelectedIds.filter((id) => validPortfolioIds.has(id));
  }, [portfolios, selectionMode, explicitSelectedIds]);

  useEffect(() => {
    if (selectionMode === 'all') {
      localStorage.setItem(STORAGE_KEY, 'all');
      localStorage.setItem(LEGACY_STORAGE_KEY, 'all');
      return;
    }

    if (selectionMode === 'none') {
      localStorage.setItem(STORAGE_KEY, 'none');
      localStorage.setItem(LEGACY_STORAGE_KEY, 'all');
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds));
    localStorage.setItem(LEGACY_STORAGE_KEY, selectedIds.length === 1 ? String(selectedIds[0]) : 'all');
  }, [selectionMode, selectedIds]);

  const setSelection = (mode, ids = []) => {
    setSelectionMode(mode);
    setExplicitSelectedIds(ids);
  };

  const selectAll = () => setSelection('all');
  const selectNone = () => setSelection('none');

  const selectPortfolios = (ids) => {
    const normalized = Array.from(new Set((ids || [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0)));

    if (!normalized.length) {
      setSelection('none');
      return;
    }

    const allIds = portfolios.map((p) => p.id);
    if (allIds.length > 0 && normalized.length === allIds.length) {
      setSelection('all');
      return;
    }

    setSelection('some', normalized);
  };

  const selectPortfolio = (id) => {
    if (id == null) {
      setSelection('all');
      return;
    }
    selectPortfolios([id]);
  };

  const togglePortfolio = (id) => {
    const portfolioId = Number(id);
    if (!Number.isInteger(portfolioId) || portfolioId <= 0) return;

    const allIds = portfolios.map((p) => p.id);
    if (!allIds.length) {
      setSelection('none');
      return;
    }

    if (selectionMode === 'all') {
      // When "All" is active, toggling one item should deselect only that item.
      setSelection('some', allIds.filter((v) => v !== portfolioId));
      return;
    }

    if (selectionMode === 'none') {
      setSelection('some', [portfolioId]);
      return;
    }

    const next = selectedIds.includes(portfolioId)
      ? selectedIds.filter((v) => v !== portfolioId)
      : [...selectedIds, portfolioId];

    if (!next.length) {
      setSelection('none');
      return;
    }

    if (next.length === allIds.length) {
      setSelection('all');
      return;
    }

    setSelection('some', next);
  };

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selectedPortfolio = selectedId
    ? portfolios.find((p) => p.id === selectedId) || null
    : null;
  const selectedPortfolios = useMemo(() => {
    if (!selectedIds.length) return portfolios;
    const selectedSet = new Set(selectedIds);
    return portfolios.filter((p) => selectedSet.has(p.id));
  }, [portfolios, selectedIds]);

  return (
    <PortfolioContext.Provider
      value={{
        portfolios,
        selectionMode,
        selectedIds,
        selectedPortfolios,
        selectedId,
        selectedPortfolio,
        selectAll,
        selectNone,
        selectPortfolios,
        selectPortfolio,
        togglePortfolio,
        refreshPortfolios: loadPortfolios,
        loading,
      }}
    >
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used within PortfolioProvider');
  return ctx;
}
