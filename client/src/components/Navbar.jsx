import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Navbar as BsNavbar, Nav, Container, Button } from 'react-bootstrap';
import { BarChart3, PlusCircle, TrendingUp, List, RefreshCw, Download, FileText, LogOut } from 'lucide-react';
import { triggerPriceUpdate, cancelPriceUpdate, exportData } from '../services/api';
import PortfolioSelector from './PortfolioSelector';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', shortLabel: 'Dashboard', icon: BarChart3 },
  { path: '/investments', label: 'Investments', shortLabel: 'Investments', icon: List },
  { path: '/performance', label: 'Performance', shortLabel: 'Performance', icon: TrendingUp },
  { path: '/transactions', label: 'Transactions', shortLabel: 'Transactions', icon: List },
  { path: '/tax', label: 'Tax Report', shortLabel: 'Tax', icon: FileText },
  { path: '/investments/add', label: 'Add Investment', shortLabel: 'Add', icon: PlusCircle },
];

export default function Navbar({ user, onLogout }) {
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
      <Container fluid="lg">
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
          <Nav className="ms-auto align-items-md-center gap-1 flex-nowrap">
            {NAV_ITEMS.map(({ path, label, shortLabel, icon: Icon }) => (
              <Nav.Link
                key={path}
                as={Link}
                to={path}
                className={`d-flex align-items-center gap-1 rounded px-2 py-2 small fw-medium text-nowrap ${
                  location.pathname === path ? 'active-nav' : 'text-secondary'
                }`}
                title={label}
              >
                <Icon size={16} />
                <span className="d-none d-xl-inline">{label}</span>
                <span className="d-xl-none">{shortLabel}</span>
              </Nav.Link>
            ))}
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={handleExport}
              disabled={exporting}
              className="d-none d-md-flex align-items-center gap-1 ms-2 text-nowrap"
              title="Export data"
            >
              <Download size={16} className={exporting ? 'spinner-rotate' : ''} />
              <span className="d-none d-xxl-inline">{exporting ? 'Exporting...' : 'Export'}</span>
            </Button>
            <Button
              variant={updating ? 'danger' : 'success'}
              size="sm"
              onClick={updating ? handleCancel : handleUpdate}
              className="d-none d-md-flex align-items-center gap-1 ms-2 text-nowrap"
              title={updating ? 'Cancel price update' : 'Update prices'}
            >
              <RefreshCw size={16} className={updating ? 'spinner-rotate' : ''} />
              <span className="d-none d-xxl-inline">{updating ? 'Cancel' : 'Update Prices'}</span>
            </Button>
            <span className="small text-muted d-none d-xxl-inline ms-2 text-nowrap">{user?.email}</span>
            <Button
              variant="outline-danger"
              size="sm"
              onClick={onLogout}
              className="d-none d-md-flex align-items-center gap-1 ms-2 text-nowrap"
              title="Logout"
            >
              <LogOut size={16} />
              <span className="d-none d-xxl-inline">Logout</span>
            </Button>
            <Button
              variant="outline-danger"
              size="sm"
              onClick={onLogout}
              className="d-md-none"
            >
              <LogOut size={16} />
            </Button>
          </Nav>
        </BsNavbar.Collapse>
      </Container>
    </BsNavbar>
  );
}
