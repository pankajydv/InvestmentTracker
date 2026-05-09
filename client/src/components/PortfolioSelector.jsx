import React, { useState, useRef, useEffect } from 'react';
import { usePortfolio } from '../context/PortfolioContext';

import { Link } from 'react-router-dom';
import { ChevronDown, Users, Settings, Check } from 'lucide-react';

export default function PortfolioSelector() {
  const { portfolios, selectedIds, selectedId, selectedPortfolio, selectPortfolio, togglePortfolio } = usePortfolio();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const allSelected = selectedIds.length === 0 || (portfolios.length > 0 && selectedIds.length === portfolios.length);
  const selectedCount = allSelected ? portfolios.length : selectedIds.length;
  const label = selectedPortfolio
    ? selectedPortfolio.name
    : allSelected
      ? 'All Portfolios'
      : `${selectedIds.length} Portfolios`;

  return (
    <div className="position-relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="d-flex align-items-center gap-2 px-3 py-2 rounded border bg-white small text-nowrap"
      >
        {selectedPortfolio ? (
          <span className="portfolio-dot flex-shrink-0" style={{ backgroundColor: selectedPortfolio.color }} />
        ) : (
          <Users size={16} className="text-muted" />
        )}
        <span className="fw-medium text-truncate" style={{ maxWidth: 132 }}>{label}</span>
        {portfolios.length > 0 && (
          <span className="text-muted flex-shrink-0" style={{ fontSize: '0.75rem' }}>
            {selectedCount}/{portfolios.length}
          </span>
        )}
        <ChevronDown
          size={16}
          className="text-muted flex-shrink-0"
          style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && (
        <div
          className="position-absolute top-100 start-0 mt-1 bg-white rounded shadow-lg border overflow-hidden"
          style={{ width: 276, zIndex: 1050 }}
        >
          {/* All Portfolios */}
          <button
            onClick={() => { selectPortfolio(null); }}
            className="w-100 d-flex align-items-center gap-2 px-3 py-2 border-0 bg-transparent text-start"
            style={{
              borderLeft: allSelected ? '4px solid #0d6efd' : '4px solid transparent',
              backgroundColor: allSelected ? '#e8f0fe' : undefined,
            }}
            onMouseEnter={(e) => { if (!allSelected) e.currentTarget.style.backgroundColor = '#f8f9fa'; }}
            onMouseLeave={(e) => { if (!allSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            <Users size={18} className="text-muted" />
            <div className="flex-grow-1">
              <div className="fw-medium">All Portfolios</div>
              <div className="text-muted" style={{ fontSize: '0.72rem', lineHeight: 1.2 }}>{portfolios.length} member{portfolios.length !== 1 ? 's' : ''}</div>
            </div>
            {allSelected && <Check size={16} className="text-primary" />}
          </button>

          <hr className="my-0" />

          {/* Individual portfolios */}
          {portfolios.map((p) => (
            <button
              key={p.id}
              onClick={() => { togglePortfolio(p.id); }}
              className="w-100 d-flex align-items-center gap-2 px-3 py-2 border-0 bg-transparent text-start"
              style={{
                borderLeft: selectedIds.includes(p.id) ? '4px solid #0d6efd' : '4px solid transparent',
                backgroundColor: selectedIds.includes(p.id) ? '#e8f0fe' : undefined,
              }}
              onMouseEnter={(e) => { if (!selectedIds.includes(p.id)) e.currentTarget.style.backgroundColor = '#f8f9fa'; }}
              onMouseLeave={(e) => { if (!selectedIds.includes(p.id)) e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span
                className="portfolio-dot flex-shrink-0"
                style={{ backgroundColor: p.color, width: 14, height: 14 }}
              />
              <div className="flex-grow-1" style={{ minWidth: 0 }}>
                <div className="fw-medium text-truncate">{p.name}</div>
                <div className="text-muted" style={{ fontSize: '0.72rem', lineHeight: 1.2 }}>
                  {p.investment_count || 0} investment{(p.investment_count || 0) !== 1 ? 's' : ''}
                </div>
              </div>
              <input
                type="checkbox"
                className="form-check-input m-0"
                checked={selectedIds.length === 0 || selectedIds.includes(p.id)}
                readOnly
              />
            </button>
          ))}

          <hr className="my-0" />

          {/* Manage & Add */}
          <Link
            to="/portfolios"
            onClick={() => setOpen(false)}
            className="w-100 d-flex align-items-center gap-2 px-3 py-2 text-decoration-none text-secondary small fw-medium"
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            <Settings size={16} />
            Manage Portfolios
          </Link>


        </div>
      )}
    </div>
  );
}
