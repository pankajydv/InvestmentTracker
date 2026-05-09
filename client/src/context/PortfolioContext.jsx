import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

const PortfolioContext = createContext();

const STORAGE_KEY = 'selectedPortfolioIds';
const LEGACY_STORAGE_KEY = 'selectedPortfolioId';

function parseStoredSelection(raw) {
  if (!raw || raw === 'all') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0);
    }
  } catch (_) {
    const legacyId = Number(raw);
    if (Number.isInteger(legacyId) && legacyId > 0) return [legacyId];
  }
  return [];
}

export function PortfolioProvider({ children }) {
  const [portfolios, setPortfolios] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored != null) return parseStoredSelection(stored);

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return parseStoredSelection(legacy);
  });
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

  useEffect(() => {
    if (!selectedIds.length) {
      localStorage.setItem(STORAGE_KEY, 'all');
      localStorage.setItem(LEGACY_STORAGE_KEY, 'all');
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds));
    localStorage.setItem(LEGACY_STORAGE_KEY, selectedIds.length === 1 ? String(selectedIds[0]) : 'all');
  }, [selectedIds]);

  const selectPortfolios = (ids) => {
    const normalized = Array.from(new Set((ids || [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0)));

    if (!normalized.length) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(normalized);
  };

  const selectPortfolio = (id) => {
    if (id == null) {
      setSelectedIds([]);
      return;
    }
    selectPortfolios([id]);
  };

  const togglePortfolio = (id) => {
    const portfolioId = Number(id);
    if (!Number.isInteger(portfolioId) || portfolioId <= 0) return;

    const allIds = portfolios.map((p) => p.id);

    if (!selectedIds.length) {
      // When "All" is active, toggling one item should deselect only that item.
      setSelectedIds(allIds.filter((v) => v !== portfolioId));
      return;
    }

    const next = selectedIds.includes(portfolioId)
      ? selectedIds.filter((v) => v !== portfolioId)
      : [...selectedIds, portfolioId];

    if (!next.length) {
      setSelectedIds([]);
      return;
    }

    setSelectedIds(next);
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
        selectedIds,
        selectedPortfolios,
        selectedId,
        selectedPortfolio,
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
