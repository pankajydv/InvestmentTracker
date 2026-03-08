import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BarChart3, PlusCircle, TrendingUp, List, Menu, X, RefreshCw } from 'lucide-react';
import { triggerPriceUpdate } from '../services/api';
import PortfolioSelector from './PortfolioSelector';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: BarChart3 },
  { path: '/investments', label: 'Investments', icon: List },
  { path: '/performance', label: 'Performance', icon: TrendingUp },
  { path: '/transactions', label: 'Transactions', icon: List },
  { path: '/investments/add', label: 'Add Investment', icon: PlusCircle },
];

export default function Navbar() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await triggerPriceUpdate();
      window.location.reload();
    } catch (e) {
      alert('Price update failed: ' + e.message);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <nav className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2">
              <TrendingUp className="h-7 w-7 text-blue-600" />
              <span className="text-xl font-bold text-gray-900 hidden sm:block">
                Investment Tracker
              </span>
            </Link>
            <div className="hidden sm:block">
              <PortfolioSelector />
            </div>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
              <Link
                key={path}
                to={path}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  location.pathname === path
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}

            <button
              onClick={handleUpdate}
              disabled={updating}
              className="ml-2 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${updating ? 'animate-spin' : ''}`} />
              {updating ? 'Updating...' : 'Update Prices'}
            </button>
          </div>

          {/* Mobile menu toggle */}
          <div className="flex items-center md:hidden gap-2">
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="p-2 rounded-lg bg-green-600 text-white"
            >
              <RefreshCw className={`h-5 w-5 ${updating ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"
            >
              {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <div className="md:hidden border-t border-gray-200 bg-white">
          <div className="px-4 py-3 space-y-1">
            <div className="sm:hidden pb-2 border-b border-gray-100 mb-2">
              <PortfolioSelector />
            </div>
            {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
              <Link
                key={path}
                to={path}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium ${
                  location.pathname === path
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <Icon className="h-5 w-5" />
                {label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
