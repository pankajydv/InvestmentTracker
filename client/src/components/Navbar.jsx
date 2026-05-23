import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Navbar as BsNavbar, Nav, Container, Button, Dropdown } from 'react-bootstrap';
import { BarChart3, PlusCircle, TrendingUp, List, RefreshCw, Download, FileText, LogOut, Menu, ScrollText, CalendarDays, UploadCloud } from 'lucide-react';
import { HolidaysListModal, HolidaysSyncModal } from './HolidaysMenuItems';
import { triggerPriceUpdate, cancelPriceUpdate, exportData } from '../services/api';
import PortfolioSelector from './PortfolioSelector';

const PRIMARY_NAV_ITEMS = [
  { path: '/', label: 'Dashboard', shortLabel: 'Dashboard', icon: BarChart3 },
  { path: '/investments', label: 'Investments', shortLabel: 'Investments', icon: List },
  { path: '/performance', label: 'Performance', shortLabel: 'Performance', icon: TrendingUp },
  { path: '/transactions', label: 'Transactions', shortLabel: 'Transactions', icon: List },
  { path: '/investments/add', label: 'Add Investment', shortLabel: 'Add', icon: PlusCircle },
];

export default function Navbar({ user, onLogout }) {
  const location = useLocation();
  const [updating, setUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showHolidays, setShowHolidays] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const currentYear = new Date().getFullYear();

  const handleUpdate = async (complianceMode = null) => {
    setUpdating(true);
    try {
      await triggerPriceUpdate(complianceMode ? { complianceMode } : undefined);
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

  const profileInitial = (user?.name || user?.email || 'U').trim().charAt(0).toUpperCase();

  return (
    <>
      <BsNavbar bg="white" sticky="top" className="shadow-sm border-bottom">
        <Container fluid="lg">
          <BsNavbar.Brand as={Link} to="/" className="d-flex align-items-center gap-2 me-2 me-md-3">
            <TrendingUp size={28} className="text-primary" />
            <span className="fw-bold d-none d-md-inline">Investment Tracker</span>
          </BsNavbar.Brand>

          <div className="d-none d-sm-block me-2">
            <PortfolioSelector />
          </div>

          <Nav className="align-items-center gap-1 flex-nowrap">
            {PRIMARY_NAV_ITEMS.map(({ path, label, shortLabel, icon: Icon }) => (
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
                <span className="d-none d-lg-inline">{label}</span>
                <span className="d-lg-none d-none d-md-inline">{shortLabel}</span>
              </Nav.Link>
            ))}
          </Nav>

          <Dropdown align="end" className="ms-auto ms-1">
            <Dropdown.Toggle
              as="button"
              id="profile-menu"
              className="btn btn-light border d-flex align-items-center gap-2 px-2 py-1"
              style={{ borderRadius: '0.5rem' }}
            >
              {user?.picture ? (
                <img
                  src={user.picture}
                  alt={user?.name || user?.email || 'Profile'}
                  style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }}
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span
                  className="d-inline-flex align-items-center justify-content-center bg-primary text-white fw-semibold"
                  style={{ width: 24, height: 24, borderRadius: '50%', fontSize: '0.72rem' }}
                >
                  {profileInitial}
                </span>
              )}
              <Menu size={16} className="text-muted" />
            </Dropdown.Toggle>

            <Dropdown.Menu style={{ minWidth: 260 }}>
              <div className="px-3 py-2 border-bottom">
                <div className="small fw-semibold text-truncate">{user?.name || 'Profile'}</div>
                <div className="small text-muted text-truncate">{user?.email}</div>
              </div>

              <Dropdown.Item as={Link} to="/tax" className="d-flex align-items-center gap-2">
                <FileText size={14} /> Tax Report
              </Dropdown.Item>

              <Dropdown.Item as={Link} to="/logs" className="d-flex align-items-center gap-2">
                <ScrollText size={14} /> App Logs
              </Dropdown.Item>

              <Dropdown.Divider />

              <Dropdown.Item onClick={() => setShowHolidays(true)} className="d-flex align-items-center gap-2">
                <CalendarDays size={14} /> List Market Holidays & Weekends
              </Dropdown.Item>
              <Dropdown.Item onClick={() => setShowSync(true)} className="d-flex align-items-center gap-2">
                <UploadCloud size={14} /> Sync/Populate Market Holidays
              </Dropdown.Item>


              <Dropdown.Item
                onClick={handleExport}
                disabled={exporting}
                className="d-flex align-items-center gap-2"
              >
                <Download size={14} className={exporting ? 'spinner-rotate' : ''} />
                {exporting ? 'Exporting...' : 'Export'}
              </Dropdown.Item>

              {updating ? (
                <Dropdown.Item onClick={handleCancel} className="d-flex align-items-center gap-2">
                  <RefreshCw size={14} className="spinner-rotate" />
                  Cancel Price Update
                </Dropdown.Item>
              ) : (
                <>
                  <Dropdown.Header className="small text-muted">Manual price update</Dropdown.Header>
                  <Dropdown.Item
                    onClick={() => handleUpdate()}
                    className="d-flex align-items-center gap-2"
                    title="Run scheduler cycle only"
                  >
                    <RefreshCw size={14} />
                    Update Prices
                  </Dropdown.Item>
                  <Dropdown.Item
                    onClick={() => handleUpdate('incremental')}
                    className="d-flex align-items-center gap-2"
                    title="Run update plus incremental compliance scan over recent/dirty window"
                  >
                    <RefreshCw size={14} />
                    Update + Fast Compliance (recent window)
                  </Dropdown.Item>
                  <Dropdown.Item
                    onClick={() => handleUpdate('full')}
                    className="d-flex align-items-center gap-2"
                    title="Run update plus full historical compliance scan"
                  >
                    <RefreshCw size={14} />
                    Update + Deep Compliance (full history)
                  </Dropdown.Item>
                </>
              )}

              <Dropdown.Divider />

              <Dropdown.Item onClick={onLogout} className="d-flex align-items-center gap-2 text-danger">
                <LogOut size={14} /> Logout
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        </Container>
      </BsNavbar>
      <HolidaysListModal show={showHolidays} onHide={() => setShowHolidays(false)} year={currentYear} />
      <HolidaysSyncModal show={showSync} onHide={() => setShowSync(false)} year={currentYear} />
    </>
  );
}
