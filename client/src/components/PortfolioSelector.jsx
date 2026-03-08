import React, { useState, useRef, useEffect } from 'react';
import { usePortfolio } from '../context/PortfolioContext';
import { ChevronDown, Users, User, Plus, Palette } from 'lucide-react';

export default function PortfolioSelector() {
  const { portfolios, selectedId, selectedPortfolio, selectPortfolio, refreshPortfolios } = usePortfolio();
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPan, setNewPan] = useState('');
  const [newColor, setNewColor] = useState('#f59e0b');
  const ref = useRef(null);

  // Close dropdown on outside click
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
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-gray-300 bg-white transition-colors text-sm"
      >
        {selectedPortfolio ? (
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: selectedPortfolio.color }}
          />
        ) : (
          <Users className="h-4 w-4 text-gray-500" />
        )}
        <span className="font-medium text-gray-800 max-w-[140px] truncate">{label}</span>
        {portfolios.length > 0 && (
          <span className="text-xs text-gray-400">
            {selectedCount} of {portfolios.length}
          </span>
        )}
        <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden">
          {/* All Portfolios option */}
          <button
            onClick={() => { selectPortfolio(null); setOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${
              selectedId === null ? 'bg-blue-50 border-l-4 border-blue-600' : 'border-l-4 border-transparent'
            }`}
          >
            <Users className="h-5 w-5 text-gray-500" />
            <div className="text-left">
              <div className="font-medium text-gray-900">All Portfolios</div>
              <div className="text-xs text-gray-500">{portfolios.length} member{portfolios.length !== 1 ? 's' : ''}</div>
            </div>
          </button>

          <div className="border-t border-gray-100" />

          {/* Individual portfolios */}
          {portfolios.map((p) => (
            <button
              key={p.id}
              onClick={() => { selectPortfolio(p.id); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${
                selectedId === p.id ? 'bg-blue-50 border-l-4 border-blue-600' : 'border-l-4 border-transparent'
              }`}
            >
              <span
                className="w-4 h-4 rounded-full flex-shrink-0"
                style={{ backgroundColor: p.color }}
              />
              <div className="text-left flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{p.name}</div>
                <div className="text-xs text-gray-500">
                  {p.investment_count || 0} investment{(p.investment_count || 0) !== 1 ? 's' : ''}
                </div>
              </div>
            </button>
          ))}

          <div className="border-t border-gray-100" />

          {/* Add new portfolio */}
          {!showAdd ? (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center gap-3 px-4 py-3 text-blue-600 hover:bg-blue-50 transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span className="text-sm font-medium">Add Family Member</span>
            </button>
          ) : (
            <div className="p-3 space-y-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name (e.g. Rahul Yadav)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
              <input
                type="text"
                value={newPan}
                onChange={(e) => setNewPan(e.target.value.toUpperCase())}
                placeholder="PAN Number (e.g. ABCDE1234F)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                maxLength={10}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Color:</span>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={`w-6 h-6 rounded-full border-2 transition-transform ${
                      newColor === c ? 'border-gray-800 scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAdd}
                  className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
                >
                  Add
                </button>
                <button
                  onClick={() => { setShowAdd(false); setNewName(''); }}
                  className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
