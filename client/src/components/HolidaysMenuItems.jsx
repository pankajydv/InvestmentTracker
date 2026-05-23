import React, { useState } from 'react';
import { Modal, Button, Table, Spinner } from 'react-bootstrap';
import { getMarketHolidays, getWeekends, syncMarketHolidays } from '../services/holidays';

function getValidYear(value, fallback = new Date().getFullYear()) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  if (parsed < 1900) return 1900;
  if (parsed > 2100) return 2100;
  return parsed;
}

function parseYear(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

export function HolidaysListModal({ show, onHide, year }) {
  const [holidays, setHolidays] = useState([]);
  const [weekends, setWeekends] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedYear, setSelectedYear] = useState(getValidYear(year));
  const [yearInput, setYearInput] = useState(String(getValidYear(year)));
  const [showWeekends, setShowWeekends] = useState(false);

  React.useEffect(() => {
    const nextYear = getValidYear(year);
    setSelectedYear(nextYear);
    setYearInput(String(nextYear));
  }, [year]);

  const commitYearInput = React.useCallback(() => {
    const parsed = parseYear(yearInput);
    const nextYear = getValidYear(parsed, selectedYear);
    setSelectedYear(nextYear);
    setYearInput(String(nextYear));
  }, [yearInput, selectedYear]);

  React.useEffect(() => {
    if (show && selectedYear) {
      setLoading(true);
      setError('');
      Promise.all([
        getMarketHolidays(selectedYear),
        getWeekends(selectedYear)
      ]).then(([holidays, weekends]) => {
        setHolidays(holidays);
        setWeekends(weekends);
      }).catch((e) => {
        setError(e?.response?.data?.error || e?.message || 'Failed to load holidays');
      }).finally(() => setLoading(false));
    }
  }, [show, selectedYear]);

  const showInitialLoader = loading && holidays.length === 0 && weekends.length === 0;

  return (
    <Modal show={show} onHide={onHide} size="lg" centered>
      <Modal.Header closeButton>
        <Modal.Title>Market Holidays ({selectedYear})</Modal.Title>
      </Modal.Header>
      <Modal.Body
        style={{
          position: 'relative',
          height: 'min(68vh, 620px)',
          overflowY: 'auto',
        }}
      >
        <div className="mb-3 d-flex align-items-center gap-2">
          <label htmlFor="holidays-year-input" className="mb-0">Year</label>
          <input
            id="holidays-year-input"
            type="number"
            min="1900"
            max="2100"
            step="1"
            className="form-control"
            style={{ maxWidth: 160 }}
            value={yearInput}
            onChange={(e) => {
              const raw = e.target.value;
              setYearInput(raw);
              const parsed = parseYear(raw);
              if (parsed != null && raw.trim().length >= 4) {
                setSelectedYear(getValidYear(parsed, selectedYear));
              }
            }}
            onBlur={commitYearInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitYearInput();
            }}
          />
          {loading ? <span className="text-muted small">Loading...</span> : null}
        </div>
        {error ? <div className="alert alert-danger py-2">{error}</div> : null}
        {showInitialLoader ? (
          <div className="d-flex align-items-center justify-content-center" style={{ minHeight: 420 }}>
            <Spinner animation="border" />
          </div>
        ) : (
          <>
            <h6>Market Holidays</h6>
            <Table size="sm" striped bordered>
              <thead><tr><th>Date</th><th>Description</th></tr></thead>
              <tbody>
                {holidays.length === 0 ? (
                  <tr><td colSpan={2} className="text-muted text-center">No market holidays found for {selectedYear}</td></tr>
                ) : null}
                {holidays.map(h => (
                  <tr key={h.date}><td>{h.date}</td><td>{h.description}</td></tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-3">
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setShowWeekends(v => !v)}
              >
                {showWeekends ? '▲ Hide Weekends' : `▼ Show Weekends (${weekends.length})`}
              </button>
            </div>
            {showWeekends && (
              <Table size="sm" striped bordered className="mt-2">
                <thead><tr><th>Date</th><th>Day</th></tr></thead>
                <tbody>
                  {weekends.length === 0 ? (
                    <tr><td colSpan={2} className="text-muted text-center">No weekend data found for {selectedYear}</td></tr>
                  ) : null}
                  {weekends.map(w => (
                    <tr key={w.date}><td>{w.date}</td><td>{w.description}</td></tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
        {loading && !showInitialLoader ? (
          <div
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              background: 'rgba(255, 255, 255, 0.92)',
              border: '1px solid #dee2e6',
              borderRadius: 16,
              padding: '2px 10px',
              fontSize: 12,
              color: '#6c757d',
            }}
          >
            Refreshing...
          </div>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide}>Close</Button>
      </Modal.Footer>
    </Modal>
  );
}

export function HolidaysSyncModal({ show, onHide, onSync, year }) {
  const [holidays, setHolidays] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [selectedYear, setSelectedYear] = useState(getValidYear(year));
  const [yearInput, setYearInput] = useState(String(getValidYear(year)));

  React.useEffect(() => {
    const nextYear = getValidYear(year);
    setSelectedYear(nextYear);
    setYearInput(String(nextYear));
  }, [year]);

  const commitYearInput = React.useCallback(() => {
    const parsed = parseYear(yearInput);
    const nextYear = getValidYear(parsed, selectedYear);
    setSelectedYear(nextYear);
    setYearInput(String(nextYear));
  }, [yearInput, selectedYear]);

  const handleSync = async () => {
    setSyncing(true);
    const holidayArr = holidays.split('\n').map(line => {
      const [date, ...descParts] = line.split(',');
      return { date: date.trim(), description: descParts.join(',').trim() };
    }).filter(h => h.date);
    await syncMarketHolidays(selectedYear, holidayArr);
    setSyncing(false);
    onSync && onSync();
    onHide();
  };

  return (
    <Modal show={show} onHide={onHide} size="md" centered>
      <Modal.Header closeButton>
        <Modal.Title>Sync/Populate Market Holidays ({selectedYear})</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="mb-2 d-flex align-items-center gap-2">
          <label htmlFor="holidays-sync-year-input" className="mb-0">Year</label>
          <input
            id="holidays-sync-year-input"
            type="number"
            min="1900"
            max="2100"
            step="1"
            className="form-control"
            style={{ maxWidth: 160 }}
            value={yearInput}
            onChange={(e) => {
              const raw = e.target.value;
              setYearInput(raw);
              const parsed = parseYear(raw);
              if (parsed != null && raw.trim().length >= 4) {
                setSelectedYear(getValidYear(parsed, selectedYear));
              }
            }}
            onBlur={commitYearInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitYearInput();
            }}
          />
        </div>
        <div className="mb-2">Paste holidays as <code>YYYY-MM-DD, Description</code> (one per line):</div>
        <textarea className="form-control mb-2" rows={8} value={holidays} onChange={e => setHolidays(e.target.value)} />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide}>Cancel</Button>
        <Button variant="primary" onClick={handleSync} disabled={syncing}>{syncing ? 'Syncing...' : 'Sync Holidays'}</Button>
      </Modal.Footer>
    </Modal>
  );
}
