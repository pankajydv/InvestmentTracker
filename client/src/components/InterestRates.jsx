import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Col, Form, Modal, Row, Spinner, Table } from 'react-bootstrap';
import { ArrowLeft, CalendarClock, Percent, Database, Pencil, Plus, Trash2, X, Check } from 'lucide-react';
import { createInterestRate, deleteInterestRate, getInterestRates, updateInterestRate } from '../services/api';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [hoveredRowId, setHoveredRowId] = useState(null);
  const [desktopHoverActions, setDesktopHoverActions] = useState(true);

  const [newRateForm, setNewRateForm] = useState({
    rate_type: 'PPF',
    rate: '',
    effective_from: '',
    effective_to: '',
  });

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    rate_type: 'PPF',
    rate: '',
    effective_from: '',
    effective_to: '',
  });

  async function loadRates() {
    try {
      setLoading(true);
      setError('');
      const data = await getInterestRates();
      setRates(data.rates || []);
    } catch (e) {
      setError(e.message || 'Failed to load interest rates');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRates();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const updateCapability = () => setDesktopHoverActions(mediaQuery.matches);
    updateCapability();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateCapability);
      return () => mediaQuery.removeEventListener('change', updateCapability);
    }

    mediaQuery.addListener(updateCapability);
    return () => mediaQuery.removeListener(updateCapability);
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

  const parseApiError = (message) => {
    if (!message) return 'Failed to save interest rate';
    return message;
  };

  async function handleCreateRate(e) {
    e.preventDefault();
    setSaveError('');
    setSaveSuccess('');
    try {
      setSaving(true);
      await createInterestRate({
        rate_type: newRateForm.rate_type,
        rate: Number(newRateForm.rate),
        effective_from: newRateForm.effective_from,
        effective_to: newRateForm.effective_to || null,
      });
      setSaveSuccess('Interest rate added successfully.');
      setNewRateForm({ ...newRateForm, rate: '', effective_from: '', effective_to: '' });
      setShowCreateModal(false);
      await loadRates();
      setSelectedType(newRateForm.rate_type);
    } catch (e2) {
      setSaveError(parseApiError(e2.message));
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(rate) {
    setEditingId(rate.id);
    setEditForm({
      rate_type: rate.rate_type,
      rate: String(rate.rate),
      effective_from: rate.effective_from,
      effective_to: rate.effective_to || '',
    });
    setSaveError('');
    setSaveSuccess('');
  }

  function cancelEdit() {
    setEditingId(null);
    setSaveError('');
  }

  function closeCreateModal() {
    setShowCreateModal(false);
    setSaveError('');
  }

  async function handleDeleteRate(rate) {
    const confirmed = window.confirm(
      `Delete ${rate.rate_type} rate ${rate.rate}% effective from ${formatDate(rate.effective_from)}?`
    );
    if (!confirmed) return;

    setSaveError('');
    setSaveSuccess('');
    try {
      setSaving(true);
      await deleteInterestRate(rate.id);
      setSaveSuccess('Interest rate deleted successfully.');
      await loadRates();
    } catch (e2) {
      setSaveError(parseApiError(e2.message));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit(id) {
    setSaveError('');
    setSaveSuccess('');
    try {
      setSaving(true);
      await updateInterestRate(id, {
        rate_type: editForm.rate_type,
        rate: Number(editForm.rate),
        effective_from: editForm.effective_from,
        effective_to: editForm.effective_to || null,
      });
      setSaveSuccess('Interest rate updated successfully.');
      setEditingId(null);
      await loadRates();
    } catch (e2) {
      setSaveError(parseApiError(e2.message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto d-flex flex-column gap-3" style={{ maxWidth: 1080 }}>
      <div>
        <Link to="/investments" className="btn btn-link btn-sm text-muted text-decoration-none d-inline-flex align-items-center gap-1 mb-1 p-0">
          <ArrowLeft size={16} /> Back to Investments
        </Link>
        <h1 className="h4 fw-bold mb-1">Interest Rates</h1>
        <p className="text-muted small mb-0">
          Review the historical interest-rate slabs used by the app for PPF, SSY, and PF.
        </p>
      </div>

      {error && <Alert variant="danger" className="small py-1 mb-0">{error}</Alert>}
      {saveError && <Alert variant="danger" className="small py-1 mb-0">{saveError}</Alert>}
      {saveSuccess && <Alert variant="success" className="small py-1 mb-0">{saveSuccess}</Alert>}

      <Row className="g-2">
        {summaries.map(({ type, current, count }) => (
          <Col key={type} md={4}>
            <Card className="shadow-sm h-100">
              <Card.Body className="py-2 px-3">
                <div className="d-flex align-items-start justify-content-between mb-1">
                  <div>
                    <div className="small text-muted">{type}</div>
                    <div className="h6 fw-bold mb-0">{current ? `${current.rate}%` : '—'}</div>
                  </div>
                  <span className="badge bg-primary-subtle text-primary-emphasis border small">Current</span>
                </div>
                <div className="small text-muted d-flex align-items-center gap-2 mb-0">
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

      <Card className="shadow-sm overflow-hidden">
        <Card.Header className="bg-white d-flex flex-column flex-md-row align-items-md-center justify-content-between gap-2 py-2 px-3">
          <div className="d-flex align-items-center gap-2">
            <Percent size={16} />
            <strong>{selectedType} rate history</strong>
          </div>
          <div className="d-flex align-items-end gap-2 flex-wrap justify-content-md-end">
            <Form.Group>
              <Form.Label className="small fw-semibold mb-1 visually-hidden">Scheme</Form.Label>
              <Form.Select
                size="sm"
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                style={{ width: 110 }}
              >
                {RATE_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </Form.Select>
            </Form.Group>
            <div className="small text-muted text-nowrap">
              DB • {filteredRates.length} slabs
            </div>
            <Button size="sm" variant="primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={14} className="me-1" /> Add
            </Button>
          </div>
        </Card.Header>
        <div className="table-responsive">
          <Table hover className="mb-0 align-middle small" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '24%' }} />
              <col style={{ width: '24%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '18%' }} />
            </colgroup>
            <thead className="table-light">
              <tr>
                <th className="px-3 py-1">Effective From</th>
                <th className="px-3 py-1">Effective To</th>
                <th className="px-3 py-1 text-end">Rate (%)</th>
                <th className="px-3 py-1 text-center">Status</th>
                <th className="px-3 py-1 text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center py-5">
                    <Spinner animation="border" variant="primary" size="sm" className="me-2" />
                    Loading rates...
                  </td>
                </tr>
              ) : filteredRates.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-5 text-muted">No rates found.</td>
                </tr>
              ) : filteredRates.map((rate) => {
                const active = isActiveRate(rate, today);
                const isEditing = editingId === rate.id;
                const showRowActions = !desktopHoverActions || hoveredRowId === rate.id;
                return (
                  <tr
                    key={rate.id}
                    onMouseEnter={() => desktopHoverActions && setHoveredRowId(rate.id)}
                    onMouseLeave={() => desktopHoverActions && setHoveredRowId((current) => (current === rate.id ? null : current))}
                  >
                    <td className="px-3 py-1 text-nowrap">
                      {isEditing ? (
                        <Form.Control
                          size="sm"
                          type="date"
                          value={editForm.effective_from}
                          onChange={(e) => setEditForm({ ...editForm, effective_from: e.target.value })}
                        />
                      ) : formatDate(rate.effective_from)}
                    </td>
                    <td className="px-3 py-1 text-nowrap">
                      {isEditing ? (
                        <Form.Control
                          size="sm"
                          type="date"
                          value={editForm.effective_to}
                          onChange={(e) => setEditForm({ ...editForm, effective_to: e.target.value })}
                        />
                      ) : (rate.effective_to ? formatDate(rate.effective_to) : '—')}
                    </td>
                    <td className="px-3 py-1 text-end fw-semibold">
                      {isEditing ? (
                        <Form.Control
                          size="sm"
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="100"
                          value={editForm.rate}
                          onChange={(e) => setEditForm({ ...editForm, rate: e.target.value })}
                        />
                      ) : `${rate.rate}%`}
                    </td>
                    <td className="px-3 py-1 text-center">
                      {active ? (
                        <span className="badge bg-success-subtle text-success-emphasis border small">Active</span>
                      ) : (
                        <span className="badge bg-light text-muted border small">Historical</span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-center text-nowrap">
                      {isEditing ? (
                        <div className="d-inline-flex align-items-center gap-1">
                          <Button size="sm" variant="outline-success" disabled={saving} onClick={() => handleSaveEdit(rate.id)} title="Save">
                            <Check size={14} />
                          </Button>
                          <Button size="sm" variant="outline-secondary" disabled={saving} onClick={cancelEdit} title="Cancel">
                            <X size={14} />
                          </Button>
                        </div>
                      ) : (
                        <div
                          className="d-inline-flex align-items-center gap-1"
                          style={{
                            opacity: showRowActions ? 1 : 0,
                            pointerEvents: showRowActions ? 'auto' : 'none',
                            transition: 'opacity 120ms ease',
                          }}
                        >
                          <Button size="sm" variant="link" className="p-1 text-primary" onClick={() => beginEdit(rate)} title="Edit">
                            <Pencil size={14} />
                          </Button>
                          <Button size="sm" variant="link" className="p-1 text-danger" onClick={() => handleDeleteRate(rate)} title="Delete">
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </Card>

      <Modal show={showCreateModal} onHide={closeCreateModal} centered>
        <Modal.Header closeButton>
          <Modal.Title className="h6 mb-0">Add Interest Rate</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleCreateRate}>
          <Modal.Body>
            <Row className="g-3">
              <Col md={4}>
                <Form.Label className="small fw-semibold mb-1">Scheme</Form.Label>
                <Form.Select
                  size="sm"
                  value={newRateForm.rate_type}
                  onChange={(e) => setNewRateForm({ ...newRateForm, rate_type: e.target.value })}
                >
                  {RATE_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={4}>
                <Form.Label className="small fw-semibold mb-1">Rate (%)</Form.Label>
                <Form.Control
                  size="sm"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="100"
                  value={newRateForm.rate}
                  onChange={(e) => setNewRateForm({ ...newRateForm, rate: e.target.value })}
                  required
                />
              </Col>
              <Col md={6}>
                <Form.Label className="small fw-semibold mb-1">Effective From</Form.Label>
                <Form.Control
                  size="sm"
                  type="date"
                  value={newRateForm.effective_from}
                  onChange={(e) => setNewRateForm({ ...newRateForm, effective_from: e.target.value })}
                  required
                />
              </Col>
              <Col md={6}>
                <Form.Label className="small fw-semibold mb-1">Effective To</Form.Label>
                <Form.Control
                  size="sm"
                  type="date"
                  value={newRateForm.effective_to}
                  onChange={(e) => setNewRateForm({ ...newRateForm, effective_to: e.target.value })}
                />
              </Col>
            </Row>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" size="sm" onClick={closeCreateModal} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? 'Saving...' : 'Add Rate'}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </div>
  );
}