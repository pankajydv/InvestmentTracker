import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Navbar as BsNavbar, Nav, Container, Button } from 'react-bootstrap';
import { BarChart3, PlusCircle, TrendingUp, List, RefreshCw, Download } from 'lucide-react';
import { triggerPriceUpdate, cancelPriceUpdate, exportData } from '../services/api';
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
  const [updating, setUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);

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

  const handleCancel = async () => {
    try { await cancelPriceUpdate(); } catch (_) { /* best effort */ }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportData();
    } catch (e) {
      alert('Export failed: ' + e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <BsNavbar bg="white" expand="md" sticky="top" className="shadow-sm border-bottom">
      <Container>
        <BsNavbar.Brand as={Link} to="/" className="d-flex align-items-center gap-2 me-3">
          <TrendingUp size={28} className="text-primary" />
          <span className="fw-bold d-none d-sm-inline">Investment Tracker</span>
        </BsNavbar.Brand>

        <div className="d-none d-sm-block me-auto">
          <PortfolioSelector />
        </div>

        <div className="d-flex align-items-center gap-2 d-md-none">
          <Button variant="outline-secondary" size="sm" onClick={handleExport} disabled={exporting}>
            <Download size={18} className={exporting ? 'spinner-rotate' : ''} />
          </Button>
          <Button
            variant={updating ? 'danger' : 'success'}
            size="sm"
            onClick={updating ? handleCancel : handleUpdate}
          >
            <RefreshCw size={18} className={updating ? 'spinner-rotate' : ''} />
          </Button>
          <BsNavbar.Toggle aria-controls="main-nav" />
        </div>

        <BsNavbar.Collapse id="main-nav">
          <div className="d-sm-hidden pb-2 border-bottom mb-2 d-block d-sm-none">
            <PortfolioSelector />
          </div>
          <Nav className="ms-auto align-items-md-center gap-1">
            {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
              <Nav.Link
                key={path}
                as={Link}
                to={path}
                className={`d-flex align-items-center gap-1 rounded px-2 py-2 small fw-medium ${
                  location.pathname === path ? 'active-nav' : 'text-secondary'
                }`}
              >
                <Icon size={16} />
                {label}
              </Nav.Link>
            ))}
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={handleExport}
              disabled={exporting}
              className="d-none d-md-flex align-items-center gap-1 ms-2"
            >
              <Download size={16} className={exporting ? 'spinner-rotate' : ''} />
              {exporting ? 'Exporting...' : 'Export'}
            </Button>
            <Button
              variant={updating ? 'danger' : 'success'}
              size="sm"
              onClick={updating ? handleCancel : handleUpdate}
              className="d-none d-md-flex align-items-center gap-1 ms-2"
            >
              <RefreshCw size={16} className={updating ? 'spinner-rotate' : ''} />
              {updating ? 'Cancel' : 'Update Prices'}
            </Button>
          </Nav>
        </BsNavbar.Collapse>
      </Container>
    </BsNavbar>
  );
}
