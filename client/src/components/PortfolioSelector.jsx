import React, { useState, useRef, useEffect } from 'react';
import { usePortfolio } from '../context/PortfolioContext';

import { Link } from 'react-router-dom';
import { ChevronDown, Users, Settings } from 'lucide-react';

export default function PortfolioSelector() {
  const { portfolios, selectedId, selectedPortfolio, selectPortfolio } = usePortfolio();
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

  const selectedCount = selectedId ? 1 : portfolios.length;
  const label = selectedPortfolio ? selectedPortfolio.name : 'All Portfolios';

  return (
    <div className="position-relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="d-flex align-items-center gap-2 px-3 py-2 rounded border bg-white small"
      >
        {selectedPortfolio ? (
          <span className="portfolio-dot flex-shrink-0" style={{ backgroundColor: selectedPortfolio.color }} />
        ) : (
          <Users size={16} className="text-muted" />
        )}
        <span className="fw-medium text-truncate" style={{ maxWidth: 140 }}>{label}</span>
        {portfolios.length > 0 && (
          <span className="text-muted" style={{ fontSize: '0.75rem' }}>
            {selectedCount} of {portfolios.length}
          </span>
        )}
        <ChevronDown
          size={16}
          className="text-muted"
          style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && (
        <div
          className="position-absolute top-100 start-0 mt-1 bg-white rounded shadow-lg border overflow-hidden"
          style={{ width: 288, zIndex: 1050 }}
        >
          {/* All Portfolios */}
          <button
            onClick={() => { selectPortfolio(null); setOpen(false); }}
            className="w-100 d-flex align-items-center gap-3 px-3 py-3 border-0 bg-transparent text-start"
            style={{
              borderLeft: selectedId === null ? '4px solid #0d6efd' : '4px solid transparent',
              backgroundColor: selectedId === null ? '#e8f0fe' : undefined,
            }}
            onMouseEnter={(e) => { if (selectedId !== null) e.currentTarget.style.backgroundColor = '#f8f9fa'; }}
            onMouseLeave={(e) => { if (selectedId !== null) e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            <Users size={20} className="text-muted" />
            <div>
              <div className="fw-medium">All Portfolios</div>
              <div className="text-muted" style={{ fontSize: '0.75rem' }}>{portfolios.length} member{portfolios.length !== 1 ? 's' : ''}</div>
            </div>
          </button>

          <hr className="my-0" />

          {/* Individual portfolios */}
          {portfolios.map((p) => (
            <button
              key={p.id}
              onClick={() => { selectPortfolio(p.id); setOpen(false); }}
              className="w-100 d-flex align-items-center gap-3 px-3 py-3 border-0 bg-transparent text-start"
              style={{
                borderLeft: selectedId === p.id ? '4px solid #0d6efd' : '4px solid transparent',
                backgroundColor: selectedId === p.id ? '#e8f0fe' : undefined,
              }}
              onMouseEnter={(e) => { if (selectedId !== p.id) e.currentTarget.style.backgroundColor = '#f8f9fa'; }}
              onMouseLeave={(e) => { if (selectedId !== p.id) e.currentTarget.style.backgroundColor = selectedId === p.id ? '#e8f0fe' : 'transparent'; }}
            >
              <span
                className="portfolio-dot flex-shrink-0"
                style={{ backgroundColor: p.color, width: 16, height: 16 }}
              />
              <div className="flex-grow-1" style={{ minWidth: 0 }}>
                <div className="fw-medium text-truncate">{p.name}</div>
                <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                  {p.investment_count || 0} investment{(p.investment_count || 0) !== 1 ? 's' : ''}
                </div>
              </div>
            </button>
          ))}

          <hr className="my-0" />

          {/* Manage & Add */}
          <Link
            to="/portfolios"
            onClick={() => setOpen(false)}
            className="w-100 d-flex align-items-center gap-3 px-3 py-2 text-decoration-none text-secondary small fw-medium"
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
