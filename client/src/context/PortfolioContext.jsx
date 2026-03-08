import React, { createContext, useContext, useState, useEffect } from 'react';

const PortfolioContext = createContext();

const STORAGE_KEY = 'selectedPortfolioId';

export function PortfolioProvider({ children }) {
  const [portfolios, setPortfolios] = useState([]);
  const [selectedId, setSelectedId] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'all' || stored === null ? null : Number(stored);
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPortfolios();
  }, []);

  const loadPortfolios = async () => {
    try {
      const res = await fetch('/api/portfolios');
      const data = await res.json();
      setPortfolios(data);
    } catch (e) {
      console.error('Failed to load portfolios:', e);
    } finally {
      setLoading(false);
    }
  };

  const selectPortfolio = (id) => {
    setSelectedId(id);
    localStorage.setItem(STORAGE_KEY, id === null ? 'all' : String(id));
  };

  const selectedPortfolio = selectedId
    ? portfolios.find((p) => p.id === selectedId) || null
    : null;

  return (
    <PortfolioContext.Provider
      value={{
        portfolios,
        selectedId,
        selectedPortfolio,
        selectPortfolio,
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
