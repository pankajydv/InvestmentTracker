import React, { useState, useRef, useEffect } from 'react';
import { Form, Button } from 'react-bootstrap';
import { usePortfolio } from '../context/PortfolioContext';
import { ChevronDown, Users, Plus } from 'lucide-react';

export default function PortfolioSelector() {
  const { portfolios, selectedId, selectedPortfolio, selectPortfolio, refreshPortfolios } = usePortfolio();
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPan, setNewPan] = useState('');
  const [newColor, setNewColor] = useState('#f59e0b');
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setShowAdd(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await fetch('/api/portfolios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), color: newColor, pan_number: newPan.trim().toUpperCase() || null }),
      });
      setNewName('');
      setNewPan('');
      setShowAdd(false);
      await refreshPortfolios();
    } catch (e) {
      alert('Failed to create portfolio: ' + e.message);
    }
  };

  const selectedCount = selectedId ? 1 : portfolios.length;
  const label = selectedPortfolio ? selectedPortfolio.name : 'All Portfolios';

  const COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];

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

          {/* Add new portfolio */}
          {!showAdd ? (
            <button
              onClick={() => setShowAdd(true)}
              className="w-100 d-flex align-items-center gap-3 px-3 py-3 border-0 bg-transparent text-primary small fw-medium"
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#e8f0fe'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <Plus size={16} />
              Add Family Member
            </button>
          ) : (
            <div className="p-3 d-flex flex-column gap-2">
              <Form.Control
                size="sm"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name (e.g. Rahul Yadav)"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
              <Form.Control
                size="sm"
                type="text"
                value={newPan}
                onChange={(e) => setNewPan(e.target.value.toUpperCase())}
                placeholder="PAN Number (e.g. ABCDE1234F)"
                className="font-monospace"
                maxLength={10}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
              <div className="d-flex align-items-center gap-2">
                <span className="text-muted" style={{ fontSize: '0.75rem' }}>Color:</span>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className="rounded-circle border-0 p-0"
                    style={{
                      width: 24,
                      height: 24,
                      backgroundColor: c,
                      border: newColor === c ? '2px solid #333' : '2px solid transparent',
                      transform: newColor === c ? 'scale(1.15)' : 'scale(1)',
                      transition: 'transform 0.15s',
                    }}
                  />
                ))}
              </div>
              <div className="d-flex gap-2">
                <Button variant="primary" size="sm" className="flex-grow-1" onClick={handleAdd}>
                  Add
                </Button>
                <Button variant="light" size="sm" onClick={() => { setShowAdd(false); setNewName(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
