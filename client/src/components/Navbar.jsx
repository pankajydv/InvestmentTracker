import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Navbar as BsNavbar, Nav, Container, Button, Dropdown, Modal, Form, Alert } from 'react-bootstrap';
import { BarChart3, PlusCircle, TrendingUp, List, RefreshCw, Download, FileText, LogOut, Menu, ScrollText, CalendarDays, UploadCloud, SlidersHorizontal, CircleHelp, BellRing } from 'lucide-react';
import { HolidaysListModal, HolidaysSyncModal } from './HolidaysMenuItems';
import { PWAInstallButton } from './PWAInstallButton';
import { triggerPriceUpdate, cancelPriceUpdate, exportData, getCorporateActionSuggestionCount } from '../services/api';
import PortfolioSelector from './PortfolioSelector';
import { useAppSettings } from '../context/AppSettingsContext';
import { usePortfolio } from '../context/PortfolioContext';

const PRIMARY_NAV_ITEMS = [
  { path: '/', label: 'Dashboard', shortLabel: 'Dashboard', icon: BarChart3 },
  { path: '/investments', label: 'Investments', shortLabel: 'Investments', icon: List },
  { path: '/performance', label: 'Performance', shortLabel: 'Performance', icon: TrendingUp },
  { path: '/transactions', label: 'Transactions', shortLabel: 'Transactions', icon: List },
  { path: '/investments/add', label: 'Add Investment', shortLabel: 'Add', icon: PlusCircle },
];

export default function Navbar({ user, onLogout }) {
  const location = useLocation();
  const { selectedId } = usePortfolio();
  const { settings, loading: settingsLoading, saving: settingsSaving, error: settingsError, saveSettings } = useAppSettings();
  const [updating, setUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showHolidays, setShowHolidays] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [draftSettings, setDraftSettings] = useState(null);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [pendingCASuggestions, setPendingCASuggestions] = useState(0);
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    let cancelled = false;
    const loadPending = async () => {
      try {
        const data = await getCorporateActionSuggestionCount(selectedId || null);
        if (!cancelled) setPendingCASuggestions(Number(data?.count || 0));
      } catch (_e) {
        if (!cancelled) setPendingCASuggestions(0);
      }
    };
    loadPending();
    return () => {
      cancelled = true;
    };
  }, [selectedId, location.pathname]);

  const openSettings = () => {
    setSettingsMessage('');
    setDraftSettings({ ...settings });
    setShowSettings(true);
  };

  const closeSettings = () => {
    if (settingsSaving) return;
    setShowSettings(false);
  };

  const handleSaveSettings = async () => {
    if (!draftSettings) return;
    try {
      const next = {
        hideSoldInvestments: !!draftSettings.hideSoldInvestments,
        includeFullySoldInReturns: draftSettings.hideSoldInvestments
          ? !!draftSettings.includeFullySoldInReturns
          : true,
      };
      await saveSettings(next);
      setDraftSettings(next);
      setSettingsMessage('Settings updated successfully.');
    } catch (_e) {
      setSettingsMessage('Failed to update settings. Please retry.');
    }
  };

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
            <Nav.Link
              as={Link}
              to="/corporate-actions"
              className={`d-flex align-items-center gap-1 rounded px-2 py-2 small fw-medium text-nowrap ${
                location.pathname === '/corporate-actions' ? 'active-nav' : 'text-secondary'
              }`}
              title="Pending"
            >
              <BellRing size={16} />
              <span className="d-none d-lg-inline">Pending</span>
              {pendingCASuggestions > 0 && (
                <span className="badge rounded-pill bg-danger">{pendingCASuggestions}</span>
              )}
            </Nav.Link>
          </Nav>

          <div className="d-flex align-items-center gap-2 ms-auto">
            <PWAInstallButton />
          </div>

          <Dropdown align="end" className="ms-1">
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

              <Dropdown.Item onClick={openSettings} className="d-flex align-items-center gap-2" disabled={settingsLoading}>
                <SlidersHorizontal size={14} /> Settings
              </Dropdown.Item>

              <Dropdown.Item as={Link} to="/faq" className="d-flex align-items-center gap-2">
                <CircleHelp size={14} /> FAQ
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
      <Modal show={showSettings} onHide={closeSettings} centered>
        <Modal.Header closeButton={!settingsSaving}>
          <Modal.Title className="h5 mb-0">Settings</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {settingsError && (
            <Alert variant="warning" className="py-2">
              {settingsError}
            </Alert>
          )}
          {settingsMessage && (
            <Alert variant={settingsMessage.toLowerCase().includes('failed') ? 'danger' : 'success'} className="py-2">
              {settingsMessage}
            </Alert>
          )}
          {!draftSettings ? (
            <div className="text-muted small">Loading settings...</div>
          ) : (
            <div className="d-flex flex-column gap-3">
              <Form.Group>
                <Form.Label className="small fw-semibold mb-2">Sold investments display</Form.Label>
                <div className="d-flex align-items-center gap-4">
                  <Form.Check
                    type="radio"
                    id="settings-hide-sold-yes"
                    label="Hide investments"
                    checked={draftSettings.hideSoldInvestments}
                    onChange={() => setDraftSettings((prev) => ({
                      ...prev,
                      hideSoldInvestments: true,
                    }))}
                  />
                  <Form.Check
                    type="radio"
                    id="settings-hide-sold-no"
                    label="Display investments"
                    checked={!draftSettings.hideSoldInvestments}
                    onChange={() => setDraftSettings((prev) => ({
                      ...prev,
                      hideSoldInvestments: false,
                      includeFullySoldInReturns: true,
                    }))}
                  />
                </div>
              </Form.Group>

              <Form.Group>
                <Form.Label className="small fw-semibold mb-2">Include fully sold investments in returns</Form.Label>
                <div className="d-flex align-items-center gap-4">
                  <Form.Check
                    type="radio"
                    id="settings-include-sold-yes"
                    label="Yes"
                    checked={!!draftSettings.includeFullySoldInReturns}
                    onChange={() => setDraftSettings((prev) => ({
                      ...prev,
                      includeFullySoldInReturns: true,
                    }))}
                  />
                  <Form.Check
                    type="radio"
                    id="settings-include-sold-no"
                    label="No"
                    checked={!draftSettings.includeFullySoldInReturns}
                    disabled={!draftSettings.hideSoldInvestments}
                    onChange={() => setDraftSettings((prev) => ({
                      ...prev,
                      includeFullySoldInReturns: false,
                    }))}
                  />
                </div>
                <Form.Text className="text-muted">
                  {!draftSettings.hideSoldInvestments
                    ? 'When sold investments are displayed, returns always include them.'
                    : 'Controls whether hidden fully sold investments are still included in total return and total cost.'}
                </Form.Text>
              </Form.Group>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={closeSettings} disabled={settingsSaving}>Cancel</Button>
          <Button variant="primary" onClick={handleSaveSettings} disabled={settingsSaving || !draftSettings}>
            {settingsSaving ? 'Saving...' : 'Update Selection'}
          </Button>
        </Modal.Footer>
      </Modal>
      <HolidaysListModal show={showHolidays} onHide={() => setShowHolidays(false)} year={currentYear} />
      <HolidaysSyncModal show={showSync} onHide={() => setShowSync(false)} year={currentYear} />
    </>
  );
}
