import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, Col, Form, Row, Spinner, Table } from 'react-bootstrap';
import { ArrowLeft, CalendarClock, Percent, Database } from 'lucide-react';
import { getInterestRates } from '../services/api';
import { formatDate } from '../utils/formatters';

const RATE_TYPES = ['PPF', 'SSY', 'PF'];

function isActiveRate(rate, today) {
  const from = new Date(rate.effective_from);
  const to = rate.effective_to ? new Date(rate.effective_to) : null;
  return from <= today && (!to || to >= today);
}

function getCurrentRate(rates, type, today) {
  const matching = rates.filter((rate) => rate.rate_type === type);
  return matching.find((rate) => isActiveRate(rate, today)) || matching[0] || null;
}

export default function InterestRates() {
  const [selectedType, setSelectedType] = useState('PPF');
  const [rates, setRates] = useState([]);
  const [datasetVersion, setDatasetVersion] = useState('');
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadRates() {
      try {
        setLoading(true);
        setError('');
        const data = await getInterestRates();
        setRates(data.rates || []);
        setDatasetVersion(data.datasetVersion || '');
        setSource(data.source || '');
      } catch (e) {
        setError(e.message || 'Failed to load interest rates');
      } finally {
        setLoading(false);
      }
    }

    loadRates();
  }, []);

  const today = useMemo(() => new Date(), []);

  const summaries = useMemo(() => (
    RATE_TYPES.map((type) => ({
      type,
      current: getCurrentRate(rates, type, today),
      count: rates.filter((rate) => rate.rate_type === type).length,
    }))
  ), [rates, today]);

  const filteredRates = useMemo(() => (
    rates.filter((rate) => rate.rate_type === selectedType)
  ), [rates, selectedType]);

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 1080 }}>
      <div>
        <Link to="/investments" className="btn btn-link btn-sm text-muted text-decoration-none d-inline-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft size={16} /> Back to Investments
        </Link>
        <h1 className="h4 fw-bold mb-1">Interest Rates</h1>
        <p className="text-muted small mb-0">
          Review the historical interest-rate slabs used by the app for PPF, SSY, and PF.
        </p>
      </div>

      {error && <Alert variant="danger" className="small py-2 mb-0">{error}</Alert>}

      {!error && source === 'reference-dataset' && (
        <Alert variant="info" className="small py-2 mb-0">
          Showing the built-in reference dataset because the database does not have synced interest-rate rows yet.
        </Alert>
      )}

      <Row className="g-3">
        {summaries.map(({ type, current, count }) => (
          <Col key={type} md={4}>
            <Card className="shadow-sm h-100">
              <Card.Body>
                <div className="d-flex align-items-start justify-content-between mb-2">
                  <div>
                    <div className="small text-muted">{type}</div>
                    <div className="h5 fw-bold mb-0">{current ? `${current.rate}%` : '—'}</div>
                  </div>
                  <span className="badge bg-primary-subtle text-primary-emphasis border">Current</span>
                </div>
                <div className="small text-muted d-flex align-items-center gap-2 mb-1">
                  <CalendarClock size={14} />
                  {current
                    ? `Effective from ${formatDate(current.effective_from)}`
                    : 'No rate available'}
                </div>
                <div className="small text-muted d-flex align-items-center gap-2">
                  <Database size={14} />
                  {count} historical entries
                </div>
              </Card.Body>
            </Card>
          </Col>
        ))}
      </Row>

      <Card className="shadow-sm">
        <Card.Body className="d-flex flex-column flex-md-row align-items-md-end justify-content-between gap-3">
          <Form.Group>
            <Form.Label className="small fw-semibold">Scheme</Form.Label>
            <Form.Select
              size="sm"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              style={{ width: 180 }}
            >
              {RATE_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </Form.Select>
          </Form.Group>
          <div className="small text-muted">
            {datasetVersion && <div>Reference dataset: <strong>{datasetVersion}</strong></div>}
            {source && <div>Viewing source: <strong>{source === 'database' ? 'Synced database' : 'Built-in reference dataset'}</strong></div>}
            <div>{filteredRates.length} rate slabs shown</div>
          </div>
        </Card.Body>
      </Card>

      <Card className="shadow-sm overflow-hidden">
        <Card.Header className="bg-white d-flex align-items-center gap-2 py-3">
          <Percent size={16} />
          <strong>{selectedType} rate history</strong>
        </Card.Header>
        <div className="table-responsive">
          <Table hover className="mb-0 align-middle small">
            <thead className="table-light">
              <tr>
                <th className="px-3 py-2">Effective From</th>
                <th className="px-3 py-2">Effective To</th>
                <th className="px-3 py-2 text-end">Rate (%)</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="text-center py-5">
                    <Spinner animation="border" variant="primary" size="sm" className="me-2" />
                    Loading rates...
                  </td>
                </tr>
              ) : filteredRates.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-5 text-muted">No rates found.</td>
                </tr>
              ) : filteredRates.map((rate) => {
                const active = isActiveRate(rate, today);
                return (
                  <tr key={rate.id}>
                    <td className="px-3 py-2 text-nowrap">{formatDate(rate.effective_from)}</td>
                    <td className="px-3 py-2 text-nowrap">{rate.effective_to ? formatDate(rate.effective_to) : '—'}</td>
                    <td className="px-3 py-2 text-end fw-semibold">{rate.rate}%</td>
                    <td className="px-3 py-2">
                      {active ? (
                        <span className="badge bg-success-subtle text-success-emphasis border">Active today</span>
                      ) : (
                        <span className="badge bg-light text-muted border">Historical</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </Card>
    </div>
  );
}